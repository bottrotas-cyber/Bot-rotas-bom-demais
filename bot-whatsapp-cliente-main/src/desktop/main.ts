import path from "path";
import { app, BrowserWindow, ipcMain } from "electron";
import { RomaneioStore } from "../services/romaneio/romaneioStore";
import { BotService } from "../bot/connection";
import {
  BotSnapshot,
  SaveCodesPayload,
  GeneralSettingsPayload,
  SaveGroupPayload,
  SaveMessageSettingsPayload,
  SaveTargetMessageSettingsPayload,
  SaveWarmupMessageSettingsPayload
} from "../shared/types";

app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-features", "Vulkan,VulkanFromANGLE,DefaultANGLEVulkan");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | undefined;
let bot: BotService;
let romaneio: RomaneioStore;
let isQuitting = false;
let lastRendererHeartbeat = 0;
let rendererRecoveryTimer: NodeJS.Timeout | undefined;

const isDev = !app.isPackaged;
const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

function createBot() {
  const dataDir = isDev ? process.cwd() : app.getPath("userData");

  romaneio = new RomaneioStore(path.join(dataDir, "romaneio"));
  bot = new BotService({
    romaneioDir: path.join(dataDir, "romaneio"),
    routeStorePath: path.join(dataDir, "route_history.json"),
    dispatchQueuePath: path.join(dataDir, "dispatch_queue.json"),
    authDir: path.join(dataDir, "auth_info"),
    configPath: path.join(dataDir, "config.json"),
    logStorePath: path.join(dataDir, "bot_logs.json"),
    telemetryPath: path.join(dataDir, "dispatch_telemetry.json")
  });

  bot.on("snapshot", (snapshot: BotSnapshot) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send("bot:snapshot", snapshot);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 640,
    title: "Bot WhatsApp",
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.setZoomFactor(1);
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const zoomShortcut = (input.control || input.meta) && ["+", "=", "-", "0"].includes(input.key);
    if (!zoomShortcut) return;
    event.preventDefault();
    mainWindow?.webContents.setZoomFactor(1);
  });

  if (isDev) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  }

  mainWindow.on("closed", () => {
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    rendererRecoveryTimer = undefined;
    mainWindow = undefined;
  });

  const repaintAndRefresh = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    const restoreStartedAt = Date.now();
    mainWindow.webContents.invalidate();
    mainWindow.webContents.send("bot:snapshot", bot.getSnapshot());
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
      mainWindow.webContents.invalidate();
      mainWindow.webContents.send("bot:snapshot", bot.getSnapshot());
    }, 180);

    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    rendererRecoveryTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
      if (lastRendererHeartbeat >= restoreStartedAt) return;
      void mainWindow.webContents.reloadIgnoringCache();
    }, 1500);
  };
  mainWindow.on("restore", repaintAndRefresh);
  mainWindow.on("show", repaintAndRefresh);
  mainWindow.on("focus", repaintAndRefresh);
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit" && mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.webContents.reload();
    }
  });
}

function registerIpc() {
  ipcMain.handle("romaneio:get", () => romaneio.all());
  ipcMain.handle("romaneio:clear", () => romaneio.clear());
  ipcMain.handle("romaneio:settings", (_event, settings) => romaneio.saveSettings(settings));
  ipcMain.handle("romaneio:locate", () => bot.locateRomaneioInGroup());
  ipcMain.handle("romaneio:confirm", (_event, candidateId: string) => bot.confirmRomaneioCandidate(candidateId));
  ipcMain.handle("romaneio:upload", (_event, fileName: string, data: ArrayBuffer) => {
    if (typeof fileName !== "string" || !/\.xlsx$/i.test(fileName) || !(data instanceof ArrayBuffer) || data.byteLength > 12 * 1024 * 1024) throw new Error("Arquivo de romaneio inválido.");
    return romaneio.saveUpload(path.basename(fileName), Buffer.from(data));
  });
  ipcMain.on("renderer:heartbeat", () => {
    lastRendererHeartbeat = Date.now();
  });
  ipcMain.handle("bot:getSnapshot", () => bot.getSnapshot());
  ipcMain.handle("bot:start", async () => {
    await bot.start();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:stop", async () => {
    await bot.stop();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:restart", async () => {
    await bot.restart();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:clearSession", async () => {
    await bot.clearSession();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:refreshQrCode", async () => {
    await bot.refreshQrCode();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:factoryReset", async () => {
    await bot.factoryReset();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:clearLogs", async () => {
    bot.clearLogs();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:refreshGroups", async () => {
    await bot.refreshGroups();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:enableMonitoring", async () => {
    await bot.enableMonitoring();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:enableImageMonitoring", async () => {
    await bot.enableImageMonitoring();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:enableNuclearMonitoring", async () => {
    await bot.enableNuclearMonitoring();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:enableTestMonitoring", async () => {
    await bot.enableTestMonitoring();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:disableMonitoring", async () => {
    bot.disableMonitoring();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:simulateOpening", async () => {
    bot.simulateOpening();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:manualDispatch", async () => {
    await bot.manualDispatch();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:simulateTargetDispatch", async () => {
    await bot.simulateTargetDispatchOnTestGroup();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:latencyProbe", async () => {
    await bot.runLatencyProbeOnTestGroup();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:saveGroup", async (_event, payload: SaveGroupPayload) => {
    await bot.saveGroup(payload.group, payload.groupId, payload.groupName);
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:saveTestGroup", async (_event, payload: SaveGroupPayload) => {
    await bot.saveTestGroup(payload.group, payload.groupId, payload.groupName);
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:saveWarmupMessageSettings", async (_event, payload: SaveWarmupMessageSettingsPayload) => {
    bot.setWarmupMessageSettings(payload.senderName, payload.codes, payload.messageCount, payload.intervalMs);
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:saveTargetMessageSettings", async (_event, payload: SaveTargetMessageSettingsPayload) => {
    bot.setMessageSettings(payload.senderName, payload.codes, payload.routes, payload.monitoredRoutes, payload.targetDispatchMode, payload.ocrCageMessageLimit, payload.ocrMaxStops, payload.ocrMaxPackages, payload.ocrRouteChoiceMode, payload.ocrRouteChoiceMetric);
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:saveRoutePreset", async (_event, payload: { name: string; routes: { cidade: string; bairro: string }[] }) => {
    bot.saveRoutePreset(payload.name, payload.routes);
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:deleteRoutePreset", async (_event, payload: { id: string }) => {
    bot.deleteRoutePreset(payload.id);
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:warmupGroups", async () => {
    await bot.warmupConnection();
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:saveCodes", async (_event, payload: SaveCodesPayload) => {
    bot.setMessageCodes(payload.codes);
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:saveMessageSettings", async (_event, payload: SaveMessageSettingsPayload) => {
    bot.setMessageSettings(
      payload.senderName,
      payload.codes,
      (payload as SaveTargetMessageSettingsPayload).routes,
      (payload as SaveTargetMessageSettingsPayload).monitoredRoutes,
      (payload as SaveTargetMessageSettingsPayload).targetDispatchMode,
      (payload as SaveTargetMessageSettingsPayload).ocrCageMessageLimit,
      (payload as SaveTargetMessageSettingsPayload).ocrMaxStops,
      (payload as SaveTargetMessageSettingsPayload).ocrMaxPackages,
      (payload as SaveTargetMessageSettingsPayload).ocrRouteChoiceMode,
      (payload as SaveTargetMessageSettingsPayload).ocrRouteChoiceMetric
    );
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:saveGeneralSettings", async (_event, payload: GeneralSettingsPayload) => {
    bot.setGeneralSettings(payload);
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:confirmOcrRoutes", async (_event, payload: { optionIds: string[] }) => {
    await bot.confirmOcrRouteSelection(Array.isArray(payload.optionIds) ? payload.optionIds : []);
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:submitRouteIncident", async (_event, payload: { routeId: string; valid: boolean; reason: string }) => {
    bot.submitClientIncident(payload.routeId, payload.valid, payload.reason);
    return bot.getSnapshot();
  });
  ipcMain.handle("bot:snoozeRouteIncident", async (_event, payload: { routeId: string }) => {
    bot.snoozeClientIncident(payload.routeId);
    return bot.getSnapshot();
  });
}

app.whenReady().then(() => {
  if (!singleInstanceLock) return;

  createBot();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("before-quit", async (event) => {
  if (!bot || isQuitting) return;
  isQuitting = true;
  event.preventDefault();
  try {
    await bot.shutdownAndClearSession();
  } finally {
    app.exit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
