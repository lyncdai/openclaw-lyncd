import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  ArtifactUploadReadyPayload,
  AssignmentPayload,
  BridgeApprovedPayload,
  BridgeAuthResultPayload,
  BridgeErrorPayload,
  BridgePendingPayload,
  BridgeWelcomePayload,
  ChannelEventPayload,
  Envelope,
  StoredCredentials,
} from "./types.js";
import {
  EventAssignment,
  EventAssignmentAck,
  EventAssignmentComplete,
  EventArtifactUploadComplete,
  EventArtifactUploadReady,
  EventArtifactUploadRequest,
  EventBridgeApproved,
  EventBridgeAuth,
  EventBridgeAuthResult,
  EventBridgeError,
  EventBridgeHello,
  EventBridgePending,
  EventBridgeRefresh,
  EventBridgeRejected,
  EventBridgeWelcome,
  EventChannelEvent,
  EventHeartbeat,
  EventMessage,
  EventStatusUpdate,
} from "./types.js";

const MIME_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function mimeFromFilename(filename: string): string {
  return MIME_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export type BridgeClientConfig = {
  alias: string;
  wsUrl: string;
  joinToken: string;
  agentName: string;
  agentDescription: string;
  agentTimeout: number;
  stateDir: string;
  getTools?: () => Promise<string[]>;
  logger: { info: (msg: string) => void; error: (msg: string) => void; warn: (msg: string) => void };
};

type AssignmentHandler = (assignment: AssignmentPayload) => Promise<void>;
type MentionHandler = (event: ChannelEventPayload) => Promise<void>;
type ChannelEventHandler = (event: ChannelEventPayload) => Promise<void>;

export class BridgeClient {
  private config: BridgeClientConfig;
  private ws: WebSocket | null = null;
  private _agentId: string | null = null;
  private _workspaceId: string | null = null;
  private jwt: string | null = null;
  private refreshToken: string | null = null;
  private authenticated = false;
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private assignmentHandler: AssignmentHandler | null = null;
  private mentionHandler: MentionHandler | null = null;
  private channelEventHandler: ChannelEventHandler | null = null;
  private pendingUploads = new Map<string, { resolve: (payload: ArtifactUploadReadyPayload) => void; reject: (err: Error) => void }>();

  constructor(config: BridgeClientConfig) {
    this.config = config;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.authenticated;
  }

  get agentId(): string | null {
    return this._agentId;
  }

  get workspaceId(): string | null {
    return this._workspaceId;
  }

  onAssignment(handler: AssignmentHandler): void {
    this.assignmentHandler = handler;
  }

  onMention(handler: MentionHandler): void {
    this.mentionHandler = handler;
  }

  onChannelEvent(handler: ChannelEventHandler): void {
    this.channelEventHandler = handler;
  }

  // -- Public lifecycle --

  async start(): Promise<void> {
    this.running = true;
    this.loadCredentials();
    await this.connectWithBackoff();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // -- Outbound messages --

  async sendMessage(channelId: string, content: string): Promise<void> {
    await this.sendEnvelope(EventMessage, { channel_id: channelId, content });
  }

  async sendAssignmentAck(assignmentId: string): Promise<void> {
    await this.sendEnvelope(EventAssignmentAck, { assignment_id: assignmentId });
  }

  async sendAssignmentComplete(assignmentId: string, success: boolean, result: string): Promise<void> {
    await this.sendEnvelope(EventAssignmentComplete, {
      assignment_id: assignmentId,
      success,
      result,
    });
  }

  async sendStatusUpdate(assignmentId: string, status: string, message: string): Promise<void> {
    await this.sendEnvelope(EventStatusUpdate, {
      assignment_id: assignmentId,
      status,
      message,
    });
  }

  async sendArtifactUploadRequest(
    channelId: string,
    filename: string,
    contentType: string,
    sizeBytes: number,
    assignmentId?: string,
    requestId?: string,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      channel_id: channelId,
      filename,
      content_type: contentType,
      size_bytes: sizeBytes,
    };
    if (assignmentId) payload.assignment_id = assignmentId;
    if (requestId) payload.request_id = requestId;
    await this.sendEnvelope(EventArtifactUploadRequest, payload);
  }

  async sendArtifactUploadComplete(artifactId: string): Promise<void> {
    await this.sendEnvelope(EventArtifactUploadComplete, { artifact_id: artifactId });
  }

  // -- Artifact upload lifecycle --

  async uploadArtifact(filePath: string, channelId: string, assignmentId?: string): Promise<void> {
    const stat = statSync(filePath);
    const filename = basename(filePath);
    const contentType = mimeFromFilename(filename);
    const requestId = randomUUID();

    // 1. Request upload slot
    await this.sendArtifactUploadRequest(channelId, filename, contentType, stat.size, assignmentId, requestId);

    // 2. Wait for bridge to respond with pre-signed URL
    const ready = await this.waitForUploadReady(requestId);

    // 3. PUT file content to the pre-signed URL
    const body = readFileSync(filePath);
    const res = await fetch(ready.upload_url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
    if (!res.ok) {
      throw new Error(`artifact PUT failed: ${res.status} ${res.statusText}`);
    }

    // 4. Notify bridge that upload is complete
    await this.sendArtifactUploadComplete(ready.artifact_id);
    this.log("info", `uploaded artifact: ${filename} (${ready.artifact_id})`);
  }

  private waitForUploadReady(requestId: string, timeoutMs = 30_000): Promise<ArtifactUploadReadyPayload> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUploads.delete(requestId);
        reject(new Error(`artifact upload ready timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingUploads.set(requestId, {
        resolve: (payload) => {
          clearTimeout(timer);
          this.pendingUploads.delete(requestId);
          resolve(payload);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pendingUploads.delete(requestId);
          reject(err);
        },
      });
    });
  }

  private handleArtifactUploadReady(payload: ArtifactUploadReadyPayload): void {
    if (payload.request_id) {
      const pending = this.pendingUploads.get(payload.request_id);
      if (pending) {
        pending.resolve(payload);
        return;
      }
    }
    this.log("warn", `received artifact_upload_ready with no matching request_id: ${payload.request_id ?? "none"}`);
  }

  // -- Connection lifecycle --

  private async connectWithBackoff(): Promise<void> {
    let backoff = 1000;

    const attempt = () => {
      if (!this.running) return;

      try {
        this.connect();
      } catch (err) {
        this.log("error", `connection failed: ${err}`);
        if (!this.running) return;
        this.log("warn", `reconnecting in ${backoff / 1000}s`);
        this.reconnectTimer = setTimeout(() => {
          backoff = Math.min(backoff * 2, 30_000);
          attempt();
        }, backoff);
      }
    };

    // Wire up reconnection on close: reset backoff on successful auth, otherwise escalate
    const onReconnect = (resetBackoff: boolean) => {
      if (!this.running) return;
      if (resetBackoff) backoff = 1000;
      this.log("warn", `connection lost, reconnecting in ${backoff / 1000}s`);
      this.reconnectTimer = setTimeout(() => {
        if (!resetBackoff) backoff = Math.min(backoff * 2, 30_000);
        attempt();
      }, backoff);
    };

    this._onReconnect = onReconnect;
    attempt();
  }

  private _onReconnect: ((resetBackoff: boolean) => void) | null = null;

  private connect(): void {
    this.authenticated = false;
    const ws = new WebSocket(this.config.wsUrl);

    ws.on("open", async () => {
      this.log("info", `connected to ${this.config.wsUrl}`);

      if (this.jwt) {
        this.sendAuth();
      } else if (this.refreshToken && this._agentId) {
        this.sendRefresh();
      } else {
        await this.sendHello();
      }
    });

    ws.on("message", (data) => {
      try {
        const envelope = JSON.parse(String(data)) as Envelope;
        this.dispatch(envelope.type, envelope.payload ?? {});
      } catch {
        this.log("warn", "received invalid JSON");
      }
    });

    ws.on("close", () => {
      this.stopHeartbeat();
      this.ws = null;
      this.authenticated = false;
      // Reject all pending upload promises
      for (const [, pending] of this.pendingUploads) {
        pending.reject(new Error("WebSocket closed"));
      }
      this.pendingUploads.clear();
      this._onReconnect?.(false);
    });

    ws.on("error", (err) => {
      this.log("error", `websocket error: ${err.message}`);
    });

    this.ws = ws;
  }

  // -- Auth flow --

  private async sendHello(): Promise<void> {
    const tools = this.config.getTools ? await this.config.getTools() : [];
    const payload: Record<string, unknown> = {
      join_token: this.config.joinToken,
      agent_name: this.config.agentName,
    };
    if (this.config.agentDescription) {
      payload.description = this.config.agentDescription;
    }
    payload.capabilities = {
      mentions: true,
      assignments: true,
      tools,
    };
    payload.runtime = {
      sdk_version: "0.1.0",
      platform: process.platform,
      language: "typescript",
    };
    this.sendEnvelopeSync(EventBridgeHello, payload);
  }

  private sendAuth(): void {
    this.sendEnvelopeSync(EventBridgeAuth, { token: this.jwt });
  }

  private sendRefresh(): void {
    this.sendEnvelopeSync(EventBridgeRefresh, {
      agent_id: this._agentId,
      refresh_token: this.refreshToken,
    });
  }

  // -- Heartbeat --

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) {
        this.sendEnvelopeSync(EventHeartbeat);
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -- Message dispatch --

  private dispatch(type: string, payload: unknown): void {
    const p = payload as Record<string, unknown>;

    switch (type) {
      case EventBridgePending:
        this.handlePending(p as unknown as BridgePendingPayload);
        break;
      case EventBridgeApproved:
        this.handleApproved(p as unknown as BridgeApprovedPayload);
        break;
      case EventBridgeAuthResult:
        this.handleAuthResult(p as unknown as BridgeAuthResultPayload);
        break;
      case EventBridgeWelcome:
        this.handleWelcome(p as unknown as BridgeWelcomePayload);
        break;
      case EventBridgeRejected:
        this.handleRejected();
        break;
      case EventBridgeError:
        this.handleError(p as unknown as BridgeErrorPayload);
        break;
      case EventAssignment:
        this.handleAssignment(p as unknown as AssignmentPayload);
        break;
      case EventChannelEvent:
        this.handleChannelEvent(p as unknown as ChannelEventPayload);
        break;
      case EventArtifactUploadReady:
        this.handleArtifactUploadReady(p as unknown as ArtifactUploadReadyPayload);
        break;
      default:
        break;
    }
  }

  private handlePending(payload: BridgePendingPayload): void {
    this._agentId = payload.agent_id;
    this.log("info", `pending approval: agent_id=${payload.agent_id} — ${payload.message}`);
  }

  private handleApproved(payload: BridgeApprovedPayload): void {
    this._agentId = payload.agent_id;
    this.jwt = payload.jwt;
    this.refreshToken = payload.refresh_token;
    this.saveCredentials(payload.agent_id, payload.jwt, payload.refresh_token);
    this.log("info", "approved, authenticating...");
    this.sendAuth();
  }

  private handleAuthResult(payload: BridgeAuthResultPayload): void {
    if (payload.success) {
      this.authenticated = true;
      if (payload.agent_id) this._agentId = payload.agent_id;
      // If a new token was returned (from refresh), save it
      if (payload.token) {
        this.jwt = payload.token;
        this.updateJwt(payload.token);
      }
      this.log("info", `authenticated: agent_id=${this._agentId}`);
      this.startHeartbeat();
    } else {
      const error = payload.error ?? "";
      if (error === "token_expired" && this.refreshToken && this._agentId) {
        this.log("info", "JWT expired, attempting refresh...");
        this.jwt = null;
        this.sendRefresh();
      } else {
        this.log("error", `auth failed: ${error}`);
        // Clear credentials so next attempt uses bridge_hello
        this.clearCredentials();
        this.jwt = null;
        this.refreshToken = null;
        this._agentId = null;
      }
    }
  }

  private handleWelcome(payload: BridgeWelcomePayload): void {
    this._workspaceId = payload.workspace_id;
    this.log("info", `welcome: workspace=${payload.workspace_id}`);
  }

  private handleRejected(): void {
    this.log("error", "agent rejected — stopping reconnection");
    this.running = false;
    this.clearCredentials();
  }

  private handleError(payload: BridgeErrorPayload): void {
    this.log("error", `bridge error: [${payload.code}] ${payload.message}`);
  }

  private async handleAssignment(payload: AssignmentPayload): Promise<void> {
    // Auto-ack
    await this.sendAssignmentAck(payload.assignment_id);
    this.log("info", `assignment received: ${payload.assignment_id}`);

    if (this.assignmentHandler) {
      try {
        await this.assignmentHandler(payload);
      } catch (err) {
        this.log("error", `assignment handler error: ${err}`);
        await this.sendAssignmentComplete(payload.assignment_id, false, `Error: ${err}`);
      }
    }
  }

  private async handleChannelEvent(payload: ChannelEventPayload): Promise<void> {
    // Route mentions to mention handler if applicable
    if (payload.is_mentioned && this.mentionHandler) {
      try {
        await this.mentionHandler(payload);
      } catch (err) {
        this.log("error", `mention handler error: ${err}`);
      }
    }

    if (this.channelEventHandler) {
      try {
        await this.channelEventHandler(payload);
      } catch (err) {
        this.log("error", `channel event handler error: ${err}`);
      }
    }
  }

  // -- Envelope sending --

  private async sendEnvelope(type: string, payload?: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    const envelope: Envelope = { type };
    if (payload !== undefined) envelope.payload = payload;
    this.ws.send(JSON.stringify(envelope));
  }

  private sendEnvelopeSync(type: string, payload?: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const envelope: Envelope = { type };
    if (payload !== undefined) envelope.payload = payload;
    this.ws.send(JSON.stringify(envelope));
  }

  // -- Credential persistence --

  private get credentialsPath(): string {
    return join(this.config.stateDir, `lyncd-creds-${this.config.alias}.json`);
  }

  private loadCredentials(): void {
    try {
      if (!existsSync(this.credentialsPath)) return;
      const data = JSON.parse(readFileSync(this.credentialsPath, "utf-8")) as StoredCredentials;
      this._agentId = data.agent_id;
      this.jwt = data.jwt;
      this.refreshToken = data.refresh_token;
      this.log("info", `loaded saved credentials for agent_id=${data.agent_id}`);
    } catch {
      // Ignore invalid credential files
    }
  }

  private saveCredentials(agentId: string, jwt: string, refreshToken: string): void {
    try {
      mkdirSync(this.config.stateDir, { recursive: true });
      const data: StoredCredentials = { agent_id: agentId, jwt, refresh_token: refreshToken };
      writeFileSync(this.credentialsPath, JSON.stringify(data), { mode: 0o600 });
    } catch (err) {
      this.log("error", `failed to save credentials: ${err}`);
    }
  }

  private updateJwt(jwt: string): void {
    try {
      if (!existsSync(this.credentialsPath)) return;
      const data = JSON.parse(readFileSync(this.credentialsPath, "utf-8")) as StoredCredentials;
      data.jwt = jwt;
      writeFileSync(this.credentialsPath, JSON.stringify(data), { mode: 0o600 });
    } catch {
      // Ignore
    }
  }

  private clearCredentials(): void {
    try {
      if (existsSync(this.credentialsPath)) unlinkSync(this.credentialsPath);
    } catch {
      // Ignore
    }
  }

  // -- Logging --

  private log(level: "info" | "error" | "warn", msg: string): void {
    const prefix = `[lyncd/${this.config.alias}]`;
    this.config.logger[level](`${prefix} ${msg}`);
  }
}
