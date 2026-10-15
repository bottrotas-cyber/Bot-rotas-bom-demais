import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";
import * as tar from "tar-stream";

const BACKUP_PREFIX = "rota-mind-backup-v1";
const BACKUP_MAGIC = Buffer.from("RMDBK001", "ascii");
const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_RETENTION_DAYS = 30;

type BackupConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  encryptionKey: Buffer;
  intervalMs: number;
  retentionDays: number;
};

export type CloudBackupStatus = {
  enabled: boolean;
  configured: boolean;
  intervalMinutes: number;
  retentionDays: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastObjectKey?: string;
  lastError?: string;
  running: boolean;
};

let status: CloudBackupStatus = {
  enabled: false,
  configured: false,
  intervalMinutes: 15,
  retentionDays: DEFAULT_RETENTION_DAYS,
  running: false
};
let activeBackup: Promise<void> | undefined;
let schedule: NodeJS.Timeout | undefined;
let client: S3Client | undefined;
let config: BackupConfig | undefined;

function parseEncryptionKey(value: string | undefined): Buffer | undefined {
  const normalized = String(value || "").trim();
  if (/^[a-f\d]{64}$/i.test(normalized)) return Buffer.from(normalized, "hex");
  if (/^[A-Za-z\d+/]{43}=$/.test(normalized)) {
    const decoded = Buffer.from(normalized, "base64");
    if (decoded.length === 32) return decoded;
  }
  return undefined;
}

function loadConfig(env: NodeJS.ProcessEnv): BackupConfig | undefined {
  const endpoint = String(env.R2_ENDPOINT || "").trim();
  const bucket = String(env.R2_BUCKET || "").trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
  const encryptionKey = parseEncryptionKey(env.R2_BACKUP_ENCRYPTION_KEY);
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !encryptionKey) return undefined;
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (parsedEndpoint.protocol !== "https:" || parsedEndpoint.username || parsedEndpoint.password) return undefined;
  const intervalMinutes = Number(env.R2_BACKUP_INTERVAL_MINUTES || 15);
  const retentionDays = Number(env.R2_BACKUP_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  return {
    endpoint: parsedEndpoint.toString().replace(/\/$/, ""),
    bucket,
    accessKeyId,
    secretAccessKey,
    encryptionKey,
    intervalMs: Number.isFinite(intervalMinutes) ? Math.max(5, Math.min(1440, intervalMinutes)) * 60_000 : DEFAULT_INTERVAL_MS,
    retentionDays: Number.isFinite(retentionDays) ? Math.max(7, Math.min(365, Math.floor(retentionDays))) : DEFAULT_RETENTION_DAYS
  };
}

function shouldSkip(relativePath: string, isDirectory: boolean) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => ["ocr-result-cache", ".git", "node_modules", "cloud-backup-temp"].includes(segment))) return true;
  const name = segments[segments.length - 1] || "";
  if (/^ocr-global-.*\.lock$/i.test(name) || /\.tmp$/i.test(name)) return true;
  if (!isDirectory && /(?:^|\/)cloud-backup\.(?:tar\.gz|enc)$/i.test(relativePath)) return true;
  return false;
}

async function addDirectoryToArchive(archive: tar.Pack, root: string, stagingDir: string, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (shouldSkip(childRelative, entry.isDirectory())) continue;
    if (/(?:-wal|-shm)$/i.test(entry.name)) continue;
    const fullPath = path.join(root, childRelative);
    if (entry.isDirectory()) {
      await addDirectoryToArchive(archive, root, stagingDir, childRelative);
    } else if (entry.isFile()) {
      let archivePath = fullPath;
      let snapshotPath: string | undefined;
      if (entry.name === "auth.sqlite") {
        snapshotPath = path.join(stagingDir, `sqlite-${crypto.randomUUID()}.db`);
        const Database = require("better-sqlite3") as new (filePath: string, options?: object) => {
          backup(destination: string): Promise<void>;
          close(): void;
        };
        const database = new Database(fullPath, { readonly: true, fileMustExist: true });
        try {
          await database.backup(snapshotPath);
        } finally {
          database.close();
        }
        archivePath = snapshotPath;
      }
      try {
        const fileStat = await fs.promises.stat(archivePath);
        await new Promise<void>((resolve, reject) => {
          const packedEntry = archive.entry({
            name: childRelative.replace(/\\/g, "/"),
            size: fileStat.size,
            mode: fileStat.mode & 0o777,
            mtime: fileStat.mtime
          }, (error) => error ? reject(error) : resolve());
          const source = fs.createReadStream(archivePath);
          source.on("error", reject);
          source.pipe(packedEntry);
        });
      } finally {
        if (snapshotPath) await fs.promises.unlink(snapshotPath).catch(() => undefined);
      }
    }
  }
}

export async function createEncryptedArchive(dataDir: string, outputPath: string, encryptionKey: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const output = fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const archive = tar.pack();
  const gzip = createGzip({ level: 1 });
  const header = Buffer.concat([BACKUP_MAGIC, iv]);

  output.write(header);
  const completed = pipeline(archive, gzip, cipher, output);
  try {
    await addDirectoryToArchive(archive, dataDir, path.dirname(outputPath));
    archive.finalize();
    await completed;
    await fs.promises.appendFile(outputPath, cipher.getAuthTag());
  } catch (error) {
    archive.destroy(error instanceof Error ? error : undefined);
    output.destroy();
    await fs.promises.unlink(outputPath).catch(() => undefined);
    throw error;
  }
}

async function uploadBackup(filePath: string, key: string, date: string) {
  if (!client || !config) throw new Error("R2 backup is not configured.");
  const file = await fs.promises.stat(filePath);
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentLength: file.size,
    ContentType: "application/vnd.rota-mind.encrypted-backup",
    Metadata: {
      format: "rota-mind-backup-v1",
      encrypted: "aes-256-gcm",
      created: date
    }
  }));
}

async function pruneOldDailyBackups() {
  if (!client || !config) return;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - config.retentionDays);
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: `${BACKUP_PREFIX}/daily/`,
      ContinuationToken: continuationToken
    }));
    const expired = (listed.Contents || [])
      .filter((item) => item.Key && item.LastModified && item.LastModified < cutoff)
      .map((item) => ({ Key: item.Key! }));
    if (expired.length) {
      await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: expired, Quiet: true } }));
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

export function getCloudBackupStatus(): CloudBackupStatus {
  return { ...status };
}

export async function runCloudBackup(dataDir: string) {
  if (!config || !client) throw new Error("Backup na nuvem ainda não está configurado no servidor.");
  if (activeBackup) return activeBackup;
  activeBackup = (async () => {
    const attemptedAt = new Date();
    status = { ...status, running: true, lastAttemptAt: attemptedAt.toISOString(), lastError: undefined };
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rota-mind-backup-"));
    const encryptedPath = path.join(tempDir, "snapshot.rmbak");
    try {
      await createEncryptedArchive(dataDir, encryptedPath, config!.encryptionKey);
      const date = attemptedAt.toISOString();
      const latestKey = `${BACKUP_PREFIX}/latest.rmbak`;
      await uploadBackup(encryptedPath, latestKey, date);
      const day = date.slice(0, 10);
      const dailyKey = `${BACKUP_PREFIX}/daily/${day}.rmbak`;
      await uploadBackup(encryptedPath, dailyKey, date);
      try {
        await pruneOldDailyBackups();
      } catch (error) {
        console.error(`[BACKUP] Snapshot enviado, mas a limpeza da retenção falhou: ${error instanceof Error ? error.message : "erro desconhecido"}`);
      }
      status = { ...status, enabled: true, configured: true, running: true, lastSuccessAt: date, lastObjectKey: latestKey, lastError: undefined };
      console.log(`[BACKUP] Snapshot criptografado enviado ao R2: ${date}.`);
    } catch (error) {
      status = { ...status, lastError: "Falha ao criar ou enviar o snapshot para o R2." };
      console.error(`[BACKUP] Envio falhou: ${error instanceof Error ? error.message : "erro desconhecido"}`);
      throw error;
    } finally {
      status = { ...status, running: false };
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();
  try {
    await activeBackup;
  } finally {
    activeBackup = undefined;
  }
}

export function startCloudBackup(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  const loaded = loadConfig(env);
  if (!loaded) {
    status = { ...status, enabled: false, configured: false, running: false };
    console.log("[BACKUP] Backup remoto aguardando as variáveis R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY e R2_BACKUP_ENCRYPTION_KEY.");
    return;
  }
  config = loaded;
  client = new S3Client({
    endpoint: loaded.endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: loaded.accessKeyId, secretAccessKey: loaded.secretAccessKey }
  });
  status = {
    ...status,
    enabled: true,
    configured: true,
    intervalMinutes: loaded.intervalMs / 60_000,
    retentionDays: loaded.retentionDays
  };
  console.log(`[BACKUP] Backup remoto ativo; intervalo ${status.intervalMinutes} min, retenção ${status.retentionDays} dias.`);
  const run = () => {
    void runCloudBackup(dataDir).catch(() => undefined);
  };
  const firstRun = setTimeout(run, 30_000);
  firstRun.unref();
  schedule = setInterval(run, loaded.intervalMs);
  schedule.unref();
}

export function stopCloudBackup() {
  if (schedule) clearInterval(schedule);
  schedule = undefined;
  client?.destroy();
  client = undefined;
  config = undefined;
}
