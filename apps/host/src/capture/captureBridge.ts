import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import type { AudioFrame, StreamSession } from "@wifi-audio-projector/protocol";

export type OnFrame = (frame: AudioFrame) => void;
export type CaptureMode = "follow-default" | "specific-device" | "all-active";

const HELPER_PACKET_HEADER_BYTES = 5;
const HELPER_FRAME_HEADER_BYTES = 16;
const HELPER_PACKET_KIND_JSON = 1;
const HELPER_PACKET_KIND_FRAME = 2;

export interface CaptureDevice {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  isCapturing: boolean;
}

export interface CaptureState {
  mode: CaptureMode;
  selectedDeviceId: string | null;
  devices: CaptureDevice[];
  helperConnected: boolean;
}

export interface CaptureSelectionCommand {
  mode: CaptureMode;
  deviceId?: string | null;
}

export type CaptureStateListener = (state: CaptureState) => void;

interface HelperReadyMessage {
  type: "ready";
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frameDurationMs: number;
}

interface HelperFrameMessage {
  type: "frame";
  sequence: number;
  timestampUs: string;
  payloadBase64: string;
}

interface HelperDevicesMessage {
  type: "devices";
  mode: CaptureMode;
  selectedDeviceId: string | null;
  devices: CaptureDevice[];
}

interface HelperErrorMessage {
  type: "error";
  message: string;
}

interface RawHelperMessage {
  [key: string]: unknown;
}

export class CaptureBridge {
  private server?: Server;
  private socket?: Socket;
  private stopping = false;
  private readonly listeners = new Set<CaptureStateListener>();
  private state: CaptureState = {
    mode: "follow-default",
    selectedDeviceId: null,
    devices: [],
    helperConnected: false
  };

  constructor(private readonly repoRoot: string) {}

  async start(onFrame: OnFrame): Promise<Pick<StreamSession, "sampleRate" | "channels" | "bitsPerSample" | "frameDurationMs" | "codec">> {
    this.stopping = false;
    this.log("CaptureBridge.start()");
    const ready = await this.startTransport(onFrame);
    this.log(`Ready received ${ready.sampleRate}Hz ${ready.channels}ch`);
    return {
      codec: "pcm16",
      sampleRate: ready.sampleRate,
      channels: ready.channels,
      bitsPerSample: ready.bitsPerSample,
      frameDurationMs: ready.frameDurationMs
    };
  }

  stop(): void {
    this.stopping = true;
    this.log("CaptureBridge.stop()");
    this.socket?.destroy();
    this.socket = undefined;
    this.server?.close();
    this.server = undefined;
    this.updateState({ helperConnected: false });
  }

  getState(): CaptureState {
    return {
      ...this.state,
      devices: this.state.devices.map((device) => ({ ...device }))
    };
  }

  onStateChanged(listener: CaptureStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  updateSelection(selection: CaptureSelectionCommand): CaptureState {
    if (selection.mode === "specific-device" && !selection.deviceId) {
      throw new Error("A device must be selected before enabling specific-device mode.");
    }

    this.sendCommand({
      type: "set-selection",
      mode: selection.mode,
      deviceId: selection.mode === "specific-device" ? selection.deviceId ?? null : null
    });

    this.updateState({
      mode: selection.mode,
      selectedDeviceId: selection.mode === "specific-device" ? selection.deviceId ?? null : null
    });

    return this.getState();
  }

  private async startTransport(onFrame: OnFrame): Promise<HelperReadyMessage> {
    const server = createServer();
    this.server = server;
    const listenPort = this.resolveHelperPort();

    const readyPromise = new Promise<HelperReadyMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.log("Timed out waiting for helper connection/message");
        reject(new Error("Timed out waiting for the Windows capture helper to connect."));
      }, 30000);
      let settled = false;

      const resolveReady = (message: HelperReadyMessage) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        resolve(message);
      };

      const rejectReady = (error: Error) => {
        if (settled) {
          this.log(`Helper transport error after ready: ${error.message}`);
          return;
        }

        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      server.on("connection", (socket) => {
        this.log(`TCP connection accepted from ${socket.remoteAddress}:${socket.remotePort}`);
        socket.setNoDelay(true);
        this.socket = socket;
        this.updateState({ helperConnected: true });
        let buffer: Buffer = Buffer.alloc(0);

        const processMessage = (message: HelperReadyMessage | HelperFrameMessage | HelperDevicesMessage | HelperErrorMessage) => {
          if (message.type === "ready") {
            this.log("Helper ready message parsed");
            resolveReady(message);
            return;
          }

          if (message.type === "frame") {
            onFrame({
              sequence: message.sequence,
              timestampUs: BigInt(message.timestampUs),
              payload: Buffer.from(message.payloadBase64, "base64")
            });
            return;
          }

          if (message.type === "devices") {
            this.updateState({
              mode: message.mode,
              selectedDeviceId: message.selectedDeviceId,
              devices: message.devices
            });
            return;
          }

          this.log(`Helper error message: ${message.message}`);
          rejectReady(new Error(message.message));
        };

        socket.on("data", (chunk: Buffer) => {
          buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

          try {
            while (buffer.length > 0) {
              if (buffer[0] === 0x7b) {
                const newlineIndex = buffer.indexOf(0x0a);
                if (newlineIndex < 0) {
                  break;
                }

                const line = buffer.subarray(0, newlineIndex).toString("utf8").trim();
                buffer = buffer.subarray(newlineIndex + 1);
                if (!line) {
                  continue;
                }

                processMessage(this.normalizeMessage(JSON.parse(line) as RawHelperMessage));
                continue;
              }

              if (buffer.length < HELPER_PACKET_HEADER_BYTES) {
                break;
              }

              const kind = buffer.readUInt8(0);
              const packetLength = buffer.readInt32LE(1);
              if (packetLength < 0) {
                throw new Error(`Invalid helper packet length: ${packetLength}`);
              }

              const totalLength = HELPER_PACKET_HEADER_BYTES + packetLength;
              if (buffer.length < totalLength) {
                break;
              }

              const payload = buffer.subarray(HELPER_PACKET_HEADER_BYTES, totalLength);
              buffer = buffer.subarray(totalLength);

              if (kind === HELPER_PACKET_KIND_JSON) {
                const line = payload.toString("utf8").trim();
                if (line) {
                  processMessage(this.normalizeMessage(JSON.parse(line) as RawHelperMessage));
                }
                continue;
              }

              if (kind === HELPER_PACKET_KIND_FRAME) {
                if (payload.length < HELPER_FRAME_HEADER_BYTES) {
                  throw new Error("Helper frame packet was shorter than its header.");
                }

                const framePayloadLength = payload.readUInt32LE(12);
                const expectedLength = HELPER_FRAME_HEADER_BYTES + framePayloadLength;
                if (payload.length !== expectedLength) {
                  throw new Error(`Helper frame payload length mismatch: expected ${expectedLength}, got ${payload.length}`);
                }

                onFrame({
                  timestampUs: payload.readBigInt64LE(0),
                  sequence: payload.readUInt32LE(8),
                  payload: Buffer.from(payload.subarray(HELPER_FRAME_HEADER_BYTES, expectedLength))
                });
                continue;
              }

              throw new Error(`Unknown helper packet kind: ${kind}`);
            }
          } catch (error) {
            const message = error instanceof Error ? error : new Error(String(error));
            this.log(`Socket parse error: ${message.message}`);
            rejectReady(message);
            socket.destroy(message);
          }
        });

        socket.on("error", (error) => {
          this.log(`Socket error: ${String(error)}`);
          rejectReady(error instanceof Error ? error : new Error(String(error)));
        });

        socket.on("close", () => {
          this.log("Socket close");
          this.socket = undefined;
          this.updateState({ helperConnected: false });
        });
      });

      server.on("error", (error) => {
        clearTimeout(timeout);
        this.log(`Server error: ${String(error)}`);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(listenPort, "127.0.0.1", () => {
        const address = server.address();
        this.log(`Listening on ${typeof address === "string" ? address : `${address?.address}:${address?.port}`}`);
        resolve();
      });
      server.on("error", reject);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to bind the helper transport port.");
    }

    if (process.env.WIFI_AUDIO_HELPER_EXTERNAL === "1") {
      console.log(`[capture-helper] waiting for externally started helper on port ${address.port}`);
      this.log(`External helper mode on port ${address.port}`);
      return readyPromise;
    }

    const helperExe = path.join(this.repoRoot, "native", "windows-capture-helper", "bin", "mode-compare", "net8.0-windows", "WindowsCaptureHelper.exe");
    if (!existsSync(helperExe)) {
      throw new Error(`Helper executable not found at ${helperExe}`);
    }

    console.log(`[capture-helper] launching via PowerShell on port ${address.port}`);
    const psCommand = `Start-Process -FilePath '${helperExe.replace(/'/g, "''")}' -ArgumentList '--port ${address.port} --frame-duration-ms 10 --outbound-queue-capacity 8' -WorkingDirectory '${this.repoRoot.replace(/'/g, "''")}'`;
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand], { cwd: this.repoRoot, windowsHide: false }, () => {});

    return readyPromise;
  }

  private sendCommand(command: Record<string, unknown>): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("The capture helper is not connected.");
    }

    const payload = `${JSON.stringify(command)}\n`;
    this.log(`Sending command: ${payload.trim()}`);
    this.socket.write(payload);
  }

  private updateState(patch: Partial<CaptureState>): void {
    this.state = {
      ...this.state,
      ...patch,
      devices: patch.devices ? patch.devices.map((device) => ({ ...device })) : this.state.devices
    };

    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private resolveHelperPort(): number {
    const raw = process.env.WIFI_AUDIO_HELPER_PORT;
    if (!raw) {
      return 0;
    }

    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private normalizeMessage(message: RawHelperMessage): HelperReadyMessage | HelperFrameMessage | HelperDevicesMessage | HelperErrorMessage {
    const type = String(message.type ?? message.Type ?? "").toLowerCase();

    if (type === "ready") {
      return {
        type: "ready",
        sampleRate: Number(message.sampleRate ?? message.SampleRate),
        channels: Number(message.channels ?? message.Channels),
        bitsPerSample: Number(message.bitsPerSample ?? message.BitsPerSample),
        frameDurationMs: Number(message.frameDurationMs ?? message.FrameDurationMs)
      };
    }

    if (type === "frame") {
      return {
        type: "frame",
        sequence: Number(message.sequence ?? message.Sequence),
        timestampUs: String(message.timestampUs ?? message.TimestampUs),
        payloadBase64: String(message.payloadBase64 ?? message.PayloadBase64)
      };
    }

    if (type === "devices") {
      const rawDevices = Array.isArray(message.devices ?? message.Devices)
        ? (message.devices ?? message.Devices) as Array<Record<string, unknown>>
        : [];

      return {
        type: "devices",
        mode: String(message.mode ?? message.Mode ?? "follow-default") as CaptureMode,
        selectedDeviceId: message.selectedDeviceId === null || message.SelectedDeviceId === null
          ? null
          : String(message.selectedDeviceId ?? message.SelectedDeviceId ?? "") || null,
        devices: rawDevices.map((device) => ({
          id: String(device.id ?? device.Id ?? ""),
          name: String(device.name ?? device.Name ?? "Unknown device"),
          isDefault: Boolean(device.isDefault ?? device.IsDefault),
          isActive: Boolean(device.isActive ?? device.IsActive),
          isCapturing: Boolean(device.isCapturing ?? device.IsCapturing)
        }))
      };
    }

    return {
      type: "error",
      message: String(message.message ?? message.Message ?? "Unknown helper message")
    };
  }

  private log(message: string): void {
    if (process.env.WIFI_AUDIO_DEBUG === "1") {
      console.log(`[capture-bridge] ${message}`);
    }
  }
}




