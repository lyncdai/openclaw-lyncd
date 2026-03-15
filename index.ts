import { execFile } from "node:child_process";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import { BridgeClient } from "./src/client.js";
import { ChannelContextStore } from "./src/context-store.js";
import { dispatchToOpenClaw } from "./src/dispatch.js";
import type { LyncdPluginConfig } from "./src/types.js";

// Static core tool definitions mirroring src/agents/tool-catalog.ts.
// Each entry maps tool ID → profiles that enable it.
const CORE_TOOLS: Array<{ id: string; profiles: string[] }> = [
  { id: "read", profiles: ["coding"] },
  { id: "write", profiles: ["coding"] },
  { id: "edit", profiles: ["coding"] },
  { id: "apply_patch", profiles: ["coding"] },
  { id: "exec", profiles: ["coding"] },
  { id: "process", profiles: ["coding"] },
  { id: "web_search", profiles: [] },
  { id: "web_fetch", profiles: [] },
  { id: "memory_search", profiles: ["coding"] },
  { id: "memory_get", profiles: ["coding"] },
  { id: "sessions_list", profiles: ["coding", "messaging"] },
  { id: "sessions_history", profiles: ["coding", "messaging"] },
  { id: "sessions_send", profiles: ["coding", "messaging"] },
  { id: "sessions_spawn", profiles: ["coding"] },
  { id: "subagents", profiles: ["coding"] },
  { id: "session_status", profiles: ["minimal", "coding", "messaging"] },
  { id: "browser", profiles: [] },
  { id: "canvas", profiles: [] },
  { id: "message", profiles: ["messaging"] },
  { id: "cron", profiles: ["coding"] },
  { id: "gateway", profiles: [] },
  { id: "nodes", profiles: [] },
  { id: "agents_list", profiles: [] },
  { id: "image", profiles: ["coding"] },
  { id: "tts", profiles: [] },
];

/** Get core tool IDs enabled for the given profile. "full" enables all. */
function getCoreToolsForProfile(profile: string): string[] {
  if (profile === "full") return CORE_TOOLS.map((t) => t.id);
  return CORE_TOOLS.filter((t) => t.profiles.includes(profile)).map((t) => t.id);
}

/** Get plugin tool names from the active registry (in-process via globalThis). */
function getPluginToolNames(): string[] {
  try {
    const REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
    const state = (globalThis as Record<symbol, unknown>)[REGISTRY_STATE] as
      | { registry: { plugins: Array<{ enabled: boolean; toolNames: string[] }> } | null }
      | undefined;
    const registry = state?.registry;
    if (!registry) return [];
    const names: string[] = [];
    for (const plugin of registry.plugins) {
      if (plugin.enabled && plugin.toolNames) names.push(...plugin.toolNames);
    }
    return names;
  } catch {
    return [];
  }
}

/** Get eligible skill names via `openclaw skills list --eligible --json`. */
function getEligibleSkills(): Promise<string[]> {
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
 * Collect all capabilities: enabled core tools + plugin tools + eligible skills.
 * Reads the tool profile from config to filter core tools.
 */
async function collectCapabilities(config: Record<string, unknown>): Promise<string[]> {
  // Resolve the active tool profile from config
  const tools = config?.tools as Record<string, unknown> | undefined;
  const profile = (tools?.profile as string) || "coding";

  // Core tools filtered by profile
  const coreTools = getCoreToolsForProfile(profile);

  // Plugin tools from globalThis registry
  const pluginTools = getPluginToolNames();

  // Eligible skills via subprocess
  const skills = await getEligibleSkills();

  // Dedupe and combine
  const all = new Set([...coreTools, ...pluginTools, ...skills]);
  return [...all];
}

const plugin: OpenClawPluginDefinition = {
  id: "openclaw-lyncd",
  name: "Lyncd Bridge",
  description: "Connect OpenClaw to Lyncd Bridge for agent collaboration",

  register(api) {
    const config = api.pluginConfig as LyncdPluginConfig | undefined;
    const agentEntries = config?.agents;
    if (!agentEntries || Object.keys(agentEntries).length === 0) return;

    // Capture the full OpenClaw config for profile resolution
    const openclawConfig = api.config as Record<string, unknown>;

    const clients = new Map<string, BridgeClient>();

    api.registerService({
      id: "lyncd-bridge",

      async start(ctx) {
        for (const [alias, agentConfig] of Object.entries(agentEntries)) {
          // Skip disabled agents
          if (agentConfig.enabled === false) continue;
          if (!agentConfig.wsUrl || !agentConfig.joinToken) {
            ctx.logger.warn(`[lyncd/${alias}] skipping: missing wsUrl or joinToken`);
            continue;
          }

          const agentTimeout = agentConfig.agentTimeout ?? 600;

          const client = new BridgeClient({
            alias,
            wsUrl: agentConfig.wsUrl,
            joinToken: agentConfig.joinToken,
            agentName: agentConfig.agentName ?? "openclaw",
            agentDescription: agentConfig.agentDescription ?? "",
            agentTimeout,
            getTools: () => collectCapabilities(openclawConfig),
            stateDir: ctx.stateDir,
            logger: ctx.logger,
          });

          // Disk-backed context buffer — survives gateway restarts
          const contextStore = new ChannelContextStore(ctx.stateDir);

          // Every channel event is observed for context; only mentions trigger a response
          client.onChannelEvent(async (event) => {
            const content = event.message?.content ?? event.content;
            if (!content) return;

            const role = event.agent_id ? "assistant" : "user";
            const name = event.message?.name ?? event.sender_id ?? undefined;

            // Always persist to disk context
            contextStore.append(event.channel_id, { role, content, name });

            // Only respond when mentioned
            if (!event.is_mentioned) return;

            ctx.logger.info(`[lyncd/${alias}] mentioned in channel ${event.channel_id}`);

            const sessionId = `lyncd-${event.channel_id}`;
            const history = contextStore.get(event.channel_id);

            const result = await dispatchToOpenClaw({
              description: content,
              messages: history.map((m) => ({ role: m.role, content: m.content, name: m.name })),
              agentTimeout,
              agentId: alias,
              sessionId,
            });

            // Agent session now owns this context — clear from disk
            contextStore.clear(event.channel_id);

            if (result.result) {
              await client.sendMessage(event.channel_id, result.result);
            }
          });

          // Wire up assignment handler
          client.onAssignment(async (assignment) => {
            ctx.logger.info(`[lyncd/${alias}] dispatching assignment ${assignment.assignment_id}`);

            await client.sendStatusUpdate(assignment.assignment_id, "running", "Dispatching to OpenClaw agent...");

            const sessionId = `lyncd-${assignment.channel_id}`;
            const result = await dispatchToOpenClaw({
              description: assignment.description,
              messages: assignment.messages,
              agentTimeout,
              agentId: alias,
              sessionId,
            });

            // Send result back as a message to the channel
            if (result.result) {
              await client.sendMessage(assignment.channel_id, result.result);
            }

            // Complete the assignment
            await client.sendAssignmentComplete(
              assignment.assignment_id,
              result.success,
              result.success ? (result.result || "Task completed.") : (result.result || "Task failed."),
            );

            ctx.logger.info(
              `[lyncd/${alias}] assignment ${assignment.assignment_id} completed: success=${result.success}`,
            );
          });

          clients.set(alias, client);

          // Start each client in background (don't await — runs indefinitely with reconnection)
          client.start().catch((err) => {
            ctx.logger.error(`[lyncd/${alias}] bridge error: ${err}`);
          });
        }
      },

      async stop() {
        await Promise.all([...clients.values()].map((c) => c.stop()));
        clients.clear();
      },
    });

    // Status gateway method — returns all agents' connection states
    api.registerGatewayMethod("lyncd.status", async ({ respond }) => {
      const statuses: Record<string, unknown> = {};
      for (const [alias, client] of clients) {
        statuses[alias] = {
          connected: client.isConnected,
          agentId: client.agentId,
          workspaceId: client.workspaceId,
        };
      }
      respond(true, { agents: statuses });
    });
  },
};

export default plugin;
