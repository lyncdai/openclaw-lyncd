// Wire protocol types matching the Lyncd Go server's internal/bridge/events.go + llm.go

// -- Event type constants --

export const EventBridgeHello = "bridge_hello" as const;
export const EventBridgeAuth = "bridge_auth" as const;
export const EventBridgeAuthResult = "bridge_auth_result" as const;
export const EventBridgeWelcome = "bridge_welcome" as const;
export const EventBridgeError = "bridge_error" as const;
export const EventBridgePending = "bridge_pending" as const;
export const EventBridgeApproved = "bridge_approved" as const;
export const EventBridgeRejected = "bridge_rejected" as const;
export const EventBridgeRefresh = "bridge_refresh" as const;
export const EventHeartbeat = "heartbeat" as const;
export const EventMessage = "message" as const;
export const EventAssignment = "assignment" as const;
export const EventAssignmentAck = "assignment_ack" as const;
export const EventStatusUpdate = "status_update" as const;
export const EventAssignmentComplete = "assignment_complete" as const;
export const EventArtifactUploadRequest = "artifact_upload_request" as const;
export const EventArtifactUploadReady = "artifact_upload_ready" as const;
export const EventArtifactUploadComplete = "artifact_upload_complete" as const;
export const EventChannelEvent = "channel_event" as const;

// -- Envelope --

export type Envelope = {
  type: string;
  payload?: unknown;
};

// -- Outbound payloads (plugin → Bridge) --

export type AgentCapabilities = {
  mentions?: boolean;
  assignments?: boolean;
  tools?: string[];
};

export type AgentRuntime = {
  sdk_version: string;
  platform: string;
  language: string;
};

export type BridgeHelloPayload = {
  join_token: string;
  agent_name: string;
  description?: string;
  capabilities?: AgentCapabilities;
  runtime?: AgentRuntime;
};

export type BridgeAuthPayload = {
  token: string;
};

export type BridgeRefreshPayload = {
  agent_id: string;
  refresh_token: string;
};

export type MessagePayload = {
  channel_id: string;
  content: string;
};

export type AssignmentAckPayload = {
  assignment_id: string;
};

export type StatusUpdatePayload = {
  assignment_id: string;
  status: string;
  message: string;
};

export type AssignmentCompletePayload = {
  assignment_id: string;
  success: boolean;
  result: string;
};

export type ArtifactUploadRequestPayload = {
  channel_id: string;
  assignment_id?: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  request_id?: string;
};

export type ArtifactUploadCompletePayload = {
  artifact_id: string;
};

// -- Inbound payloads (Bridge → plugin) --

export type BridgePendingPayload = {
  agent_id: string;
  message: string;
};

export type BridgeApprovedPayload = {
  agent_id: string;
  jwt: string;
  refresh_token: string;
};

export type BridgeAuthResultPayload = {
  success: boolean;
  agent_id?: string;
  error?: string;
  token?: string;
};

export type BridgeWelcomePayload = {
  agent_id: string;
  workspace_id: string;
};

export type BridgeErrorPayload = {
  code: string;
  message: string;
};

export type AssignmentPayload = {
  assignment_id: string;
  channel_id: string;
  description: string;
  messages?: LLMMessage[];
  tools?: LLMToolDef[];
};

export type ArtifactUploadReadyPayload = {
  artifact_id: string;
  upload_url: string;
  request_id?: string;
};

// -- LLM types (OpenAI-compatible, from bridge/llm.go) --

export type LLMFunctionCall = {
  name: string;
  arguments: string;
};

export type LLMToolCall = {
  id: string;
  type: string;
  function: LLMFunctionCall;
};

export type LLMMessage = {
  role: string;
  content?: string;
  name?: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
};

export type LLMFunctionDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type LLMToolDef = {
  type: string;
  function: LLMFunctionDef;
};

// -- Channel events --

export type MentionInfo = {
  agent_id: string;
  agent_name: string;
};

export type ChannelEventPayload = {
  channel_id: string;
  event_id: string;
  type: string;
  content: string;
  sender_id?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
  message?: LLMMessage;
  mentions?: MentionInfo[];
  is_mentioned?: boolean;
};

// -- Plugin config types --

export type LyncdAgentConfig = {
  agentDescription?: string;
  agentTimeout?: number;
  enabled?: boolean;
};

export type LyncdPluginConfig = {
  joinToken: string;
  wsUrl?: string;
  agents?: Record<string, LyncdAgentConfig>;
};

// -- Credential store --

export type StoredCredentials = {
  agent_id: string;
  jwt: string;
  refresh_token: string;
};
