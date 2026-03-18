import { execFile, spawn } from "node:child_process";
import type { LLMMessage } from "./types.js";

type DispatchResult = {
  success: boolean;
  result: string;
};

type AgentGatewayResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string | null;
    mediaUrls?: string[];
  }>;
  meta?: unknown;
};

type GatewayAgentResponse = {
  runId?: string;
  status?: string;
  summary?: string;
  result?: AgentGatewayResult;
};

/**
 * Build a human-readable message from assignment description + conversation history.
 */
function buildAgentMessage(opts: { description: string; messages?: LLMMessage[] }): string {
  const parts: string[] = [];

  // Include conversation history if present
  if (opts.messages?.length) {
    parts.push("## Conversation Context\n");
    for (const msg of opts.messages) {
      if (msg.content) {
        const role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role;
        parts.push(`**${role}:** ${msg.content}`);
      }
    }
    parts.push("\n## Assignment\n");
  }

  parts.push(opts.description);
  return parts.join("\n");
}

/** Parse agent response JSON, extracting text from payloads. */
function parseAgentResponse(stdout: string): DispatchResult {
  try {
    const response = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const texts: string[] = [];

    // payloads is at the top level, not under result
    const payloads = (response.payloads ?? (response as GatewayAgentResponse).result?.payloads) as
      | Array<{ text?: string }>
      | undefined;
    if (payloads) {
      for (const payload of payloads) {
        if (payload.text) texts.push(payload.text);
      }
    }

    const combinedText =
      texts.join("\n\n") || (response as GatewayAgentResponse).summary || "Task completed.";
    return { success: true, result: combinedText };
  } catch {
    // If stdout isn't valid JSON, return it as-is
    const text = stdout.trim() || "Task completed (no output).";
    return { success: true, result: text };
  }
}

/** Get eligible skill names via `openclaw skills list --eligible --json`. */
export function getEligibleSkills(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "openclaw",
      ["skills", "list", "--eligible", "--json"],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const names: string[] = [];
          for (const skill of data?.skills ?? []) {
            if (skill.eligible && skill.name) names.push(skill.name);
          }
          resolve(names);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/**
 * Dispatch an assignment to an OpenClaw agent via `openclaw agent --json` subprocess.
 * Uses --session-id for per-channel session continuity.
 */
export async function dispatchToOpenClaw(opts: {
  description: string;
  messages?: LLMMessage[];
  agentTimeout: number;
  agentId?: string;
  sessionId?: string;
}): Promise<DispatchResult> {
  const message = buildAgentMessage(opts);

  return new Promise<DispatchResult>((resolve) => {
    const args = [
      "agent",
      "--message", message,
      "--json",
      "--agent", opts.agentId || "main",
      "--timeout", String(opts.agentTimeout),
    ];
    if (opts.sessionId) {
      args.push("--session-id", opts.sessionId);
    }

    const proc = spawn("openclaw", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      resolve({ success: false, result: `Failed to spawn openclaw: ${err.message}` });
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        const errorMsg = stderr.trim() || `openclaw agent exited with code ${code}`;
        resolve({ success: false, result: errorMsg });
        return;
      }
      resolve(parseAgentResponse(stdout));
    });
  });
}

