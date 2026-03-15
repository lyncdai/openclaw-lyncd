import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type ContextMessage = {
  role: string;
  content: string;
  name?: string;
  ts: number;
};

/**
 * Persists per-channel context messages as JSON files on disk.
 * On mention, the context is read, passed to the agent, and cleared
 * (the agent's session now owns that history).
 */
export class ChannelContextStore {
  private dir: string;
  private maxMessages: number;
  // In-memory write-back cache to avoid reading disk on every append
  private cache = new Map<string, ContextMessage[]>();

  constructor(stateDir: string, maxMessages = 50) {
    this.dir = join(stateDir, "lyncd-context");
    this.maxMessages = maxMessages;
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(channelId: string): string {
    // Sanitize channelId for safe filenames
    const safe = channelId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }

  /** Append a message to the channel's context buffer (memory + disk). */
  append(channelId: string, msg: Omit<ContextMessage, "ts">): void {
    const entry: ContextMessage = { ...msg, ts: Date.now() };
    let messages = this.cache.get(channelId);
    if (!messages) {
      messages = this.load(channelId);
      this.cache.set(channelId, messages);
    }
    messages.push(entry);
    if (messages.length > this.maxMessages) {
      messages.splice(0, messages.length - this.maxMessages);
    }
    this.save(channelId, messages);
  }

  /** Read all buffered context for a channel. */
  get(channelId: string): ContextMessage[] {
    const cached = this.cache.get(channelId);
    if (cached) return cached;
    const messages = this.load(channelId);
    this.cache.set(channelId, messages);
    return messages;
  }

  /** Clear the channel's context (after dispatch — agent session now has it). */
  clear(channelId: string): void {
    this.cache.set(channelId, []);
    const path = this.filePath(channelId);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // Ignore cleanup errors
    }
  }

  private load(channelId: string): ContextMessage[] {
    const path = this.filePath(channelId);
    try {
      if (!existsSync(path)) return [];
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (Array.isArray(data)) return data as ContextMessage[];
      return [];
    } catch {
      return [];
    }
  }

  private save(channelId: string, messages: ContextMessage[]): void {
    const path = this.filePath(channelId);
    try {
      writeFileSync(path, JSON.stringify(messages));
    } catch {
      // Best-effort persistence
    }
  }
}
