const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { gunzipSync } = require("node:zlib");

const { createEncryptedArchive } = require("../dist/services/cloudBackup.js");

test("backup criptografado compacta os dados persistentes e exclui cache descartavel", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rota-backup-test-"));
  const dataDir = path.join(temp, "data");
  const output = path.join(temp, "snapshot.rmbak");
  fs.mkdirSync(path.join(dataDir, "users", "cliente", "auth_info"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "ocr-result-cache"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "users", "cliente", "config.json"), "preferencias importantes");
  const Database = require("better-sqlite3");
  const sessionDb = new Database(path.join(dataDir, "users", "cliente", "auth_info", "auth.sqlite"));
  sessionDb.pragma("journal_mode = WAL");
  sessionDb.exec("CREATE TABLE session_data (value TEXT); INSERT INTO session_data VALUES ('sessao whatsapp')");
  fs.writeFileSync(path.join(dataDir, "ocr-result-cache", "cache.json"), "cache descartavel");

  try {
    const key = crypto.randomBytes(32);
    await createEncryptedArchive(dataDir, output, key);
    const encrypted = fs.readFileSync(output);
    assert.equal(encrypted.subarray(0, 8).toString("ascii"), "RMDBK001");
    const iv = encrypted.subarray(8, 20);
    const tag = encrypted.subarray(-16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const compressed = Buffer.concat([decipher.update(encrypted.subarray(20, -16)), decipher.final()]);
    const archive = gunzipSync(compressed).toString("latin1");
    assert.match(archive, /users[\\/]cliente[\\/]config\.json/);
    assert.match(archive, /preferencias importantes/);
    assert.match(archive, /auth\.sqlite/);
    assert.match(archive, /sessao whatsapp/);
    assert.doesNotMatch(archive, /cache descartavel/);

    const corrupted = Buffer.from(encrypted);
    corrupted[corrupted.length - 1] ^= 0xff;
    const invalid = crypto.createDecipheriv("aes-256-gcm", key, corrupted.subarray(8, 20));
    invalid.setAuthTag(corrupted.subarray(-16));
    assert.throws(() => {
      invalid.update(corrupted.subarray(20, -16));
      invalid.final();
    });
  } finally {
    sessionDb.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
