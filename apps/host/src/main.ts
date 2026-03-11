import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SESSION } from "@wifi-audio-projector/protocol";
import { CaptureBridge, type CaptureSelectionCommand } from "./capture/captureBridge.js";
import { AudioStreamServer } from "./server/audioStreamServer.js";
import { MdnsAdvertiser } from "./server/mdnsAdvertiser.js";
import type { HostConsoleData } from "./types.js";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const publicDir = path.join(appRoot, "public");
const WEB_PORT = Number.parseInt(process.env.WIFI_AUDIO_WEB_PORT ?? "39394", 10);

async function bootstrap(): Promise<void> {
  let server: AudioStreamServer | undefined;
  let mainWindow: BrowserWindow | undefined;

  const captureBridge = new CaptureBridge(repoRoot);
  const captureSession = await captureBridge.start((frame) => {
    if (!server) {
      return;
    }

    server.setStreaming(true);
    server.broadcastFrame(frame);
  });

  server = new AudioStreamServer({
    publicDir,
    port: WEB_PORT,
    session: {
      ...DEFAULT_SESSION,
      ...captureSession,
      hostName: `${app.getName()} Host`,
      sessionId: `session-${Date.now()}`
    }
  });
  const mdns = new MdnsAdvertiser();

  const port = await server.listen(WEB_PORT);
  mdns.start(port, server.getStatus().session);

  const status = server.getStatus();
  const baseUrl = status.addresses[0]
    ? `http://${status.addresses[0]}:${status.port}`
    : `http://localhost:${status.port}`;
  const hostUiData: HostConsoleData = {
    receiverUrl: `${baseUrl}/receiver`,
    vlcUrl: `${baseUrl}/listen.wav`,
    addresses: status.addresses,
    format: `${server.getStatus().session.sampleRate} Hz / ${server.getStatus().session.channels} ch / ${server.getStatus().session.bitsPerSample}-bit / ${server.getStatus().session.frameDurationMs} ms`
  };

  mainWindow = new BrowserWindow({
    width: 430,
    height: 760,
    minWidth: 380,
    minHeight: 620,
    useContentSize: true,
    autoHideMenuBar: true,
    maximizable: false,
    backgroundColor: "#050505",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.webContents.on("console-message", (_event, _level, message) => {
    console.log("[host-ui]", message);
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error("Host window failed to load:", errorCode, errorDescription);
  });

  ipcMain.handle("host:get-ui-data", () => hostUiData);
  ipcMain.handle("capture:get-state", () => captureBridge.getState());
  ipcMain.handle("capture:update-selection", (_event, selection: CaptureSelectionCommand) => captureBridge.updateSelection(selection));

  captureBridge.onStateChanged((captureState) => {
    if (!captureState.devices.some((device) => device.isCapturing)) {
      server?.setStreaming(false);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("capture:state", captureState);
    }
  });

  await mainWindow.loadFile(path.join(publicDir, "host.html"));
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send("capture:state", captureBridge.getState());
  }

  server.setWebRtcAnswerHandler(async () => {
    throw new Error("Direct receiver mode is disabled while we stabilize the reliable PCM path.");
  });

  app.on("before-quit", () => {
    ipcMain.removeHandler("host:get-ui-data");
    ipcMain.removeHandler("capture:get-state");
    ipcMain.removeHandler("capture:update-selection");
    captureBridge.stop();
    mdns.stop();
    server?.close();
  });
}

app.whenReady().then(() => {
  void bootstrap().catch((error) => {
    console.error(error);
    app.quit();
  });
});

