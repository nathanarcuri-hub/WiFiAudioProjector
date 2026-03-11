import express from "express";
import path from "node:path";
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_SESSION,
  encodeAudioFrame,
  type AudioFrame,
  type HostHelloMessage,
  type HostStatusMessage,
  type StreamSession
} from "@wifi-audio-projector/protocol";
import type { HostRuntimeStatus } from "../types.js";
import { getLanAddresses } from "./networkInfo.js";

export interface AudioStreamServerOptions {
  publicDir: string;
  port?: number;
  session?: StreamSession;
}

type WebRtcOffer = {
  type: string;
  sdp: string;
};

type WebRtcAnswerHandler = (offer: WebRtcOffer, profileId?: string) => Promise<WebRtcOffer>;

export class AudioStreamServer {
  private readonly app = express();
  private readonly server: HttpServer;
  private readonly wsServer: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly wavClients = new Set<ServerResponse>();
  private session: StreamSession;
  private status: HostRuntimeStatus;
  private webRtcAnswerHandler?: WebRtcAnswerHandler;

  constructor(options: AudioStreamServerOptions) {
    this.session = options.session ?? DEFAULT_SESSION;
    this.status = {
      streaming: false,
      connectedClients: 0,
      session: this.session,
      port: options.port ?? 0,
      addresses: []
    };

    this.app.use(express.json({ limit: "1mb" }));
    this.app.use(express.static(options.publicDir));

    this.app.get('/health', (_request, response) => {
      response.json({ ok: true });
    });

    this.app.get('/session', (_request, response) => {
      response.json(this.session);
    });

    this.app.get('/receiver', (_request, response) => {
      response.sendFile(path.join(options.publicDir, 'receiver.html'));
    });

    this.app.get('/receiver-low-latency', (_request, response) => {
      response.redirect(302, '/receiver');
    });

    this.app.get('/listen.wav', (_request, response) => {
      response.status(200);
      response.setHeader('Content-Type', 'audio/wav');
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('Expires', '0');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('Transfer-Encoding', 'chunked');
      response.flushHeaders();
      response.write(createWavHeader(this.session));

      this.wavClients.add(response);
      this.updateStatus();

      const cleanup = () => {
        this.wavClients.delete(response);
        this.updateStatus();
      };

      response.on('close', cleanup);
      response.on('finish', cleanup);
      response.on('error', cleanup);
    });

    this.app.post('/webrtc/offer', async (request, response) => {
      if (!this.webRtcAnswerHandler) {
        response.status(503).json({ error: 'Low-latency sender is not ready yet.' });
        return;
      }

      try {
        const body = request.body as Partial<WebRtcOffer>;
        if (typeof body?.type !== 'string' || typeof body?.sdp !== 'string') {
          response.status(400).json({ error: 'Invalid WebRTC offer.' });
          return;
        }

        const profileId = typeof request.query.profile === 'string' ? request.query.profile : undefined;
        const answer = await this.webRtcAnswerHandler({ type: body.type, sdp: body.sdp }, profileId);
        response.json(answer);
      } catch (error) {
        response.status(500).json({ error: error instanceof Error ? error.message : 'WebRTC negotiation failed.' });
      }
    });

    this.server = createServer(this.app);
    this.wsServer = new WebSocketServer({
      server: this.server,
      path: '/stream'
    });

    this.wsServer.on('connection', (socket) => {
      this.clients.add(socket);
      this.updateStatus();
      this.sendHello(socket);
      this.sendStatus(socket);

      socket.on('close', () => {
        this.clients.delete(socket);
        this.updateStatus();
      });
    });
  }

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve) => {
      this.server.listen(port, resolve);
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unable to resolve listening port.');
    }

    this.status = {
      ...this.status,
      port: address.port,
      addresses: getLanAddresses()
    };

    return address.port;
  }

  getStatus(): HostRuntimeStatus {
    return this.status;
  }

  updateSession(session: StreamSession): void {
    this.session = session;
    this.status = {
      ...this.status,
      session
    };
  }

  setStreaming(streaming: boolean): void {
    this.status = {
      ...this.status,
      streaming
    };
    this.broadcastStatus();
  }

  setWebRtcAnswerHandler(handler: WebRtcAnswerHandler): void {
    this.webRtcAnswerHandler = handler;
  }

  broadcastFrame(frame: AudioFrame): void {
    const payload = encodeAudioFrame(frame);

    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload, { binary: true });
      }
    }

    for (const response of [...this.wavClients]) {
      if (response.writableEnded || response.destroyed) {
        this.wavClients.delete(response);
        continue;
      }

      try {
        response.write(frame.payload);
      } catch {
        this.wavClients.delete(response);
        response.destroy();
      }
    }
  }

  close(): void {
    for (const response of this.wavClients) {
      response.end();
    }
    this.wavClients.clear();
    this.wsServer.close();
    this.server.close();
  }

  private sendHello(socket: WebSocket): void {
    const message: HostHelloMessage = {
      type: 'hello',
      ...this.session
    };

    socket.send(JSON.stringify(message));
  }

  private sendStatus(socket: WebSocket): void {
    const message: HostStatusMessage = {
      type: 'status',
      streaming: this.status.streaming,
      connectedClients: this.clientCount
    };

    socket.send(JSON.stringify(message));
  }

  private broadcastStatus(): void {
    const message: HostStatusMessage = {
      type: 'status',
      streaming: this.status.streaming,
      connectedClients: this.clientCount
    };

    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  private updateStatus(): void {
    this.status = {
      ...this.status,
      connectedClients: this.clientCount
    };
    this.broadcastStatus();
  }

  private get clientCount(): number {
    return this.clients.size + this.wavClients.size;
  }
}

function createWavHeader(session: StreamSession): Buffer {
  const blockAlign = session.channels * (session.bitsPerSample / 8);
  const byteRate = session.sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(session.channels, 22);
  header.writeUInt32LE(session.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(session.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(0xffffffff, 40);

  return header;
}




