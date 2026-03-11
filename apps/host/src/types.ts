import type { StreamSession } from "@wifi-audio-projector/protocol";

export interface HostRuntimeStatus {
  streaming: boolean;
  connectedClients: number;
  session: StreamSession;
  port: number;
  addresses: string[];
}

export interface HostConsoleData {
  receiverUrl: string;
  vlcUrl: string;
  addresses: string[];
  format: string;
}
