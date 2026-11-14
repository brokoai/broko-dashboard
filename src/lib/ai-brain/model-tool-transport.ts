import { LlmError } from "./classifier";
import type { AiBrainConfig } from "./config";

/**
 * The Anthropic Messages API WITH tool use (server-side only). It is the same provider, key and model setting as `createModelTransport`; the only
 * difference is that a turn can carry `tools` and return `tool_use` blocks, which the caller (chat/tool-agent.ts) runs through the Tool Registry.
 * This file executes nothing. Errors never include the key, the prompt or the response body.
 */

export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }

export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type TextBlock = { type: "text"; text: string };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type ToolMessage = { role: "user" | "assistant"; content: string | (TextBlock | ToolUseBlock | ToolResultBlock)[] };

export interface ToolTurnRequest {
  system: string; messages: ToolMessage[]; tools: ToolDef[]; maxTokens: number;
  /** "none" forbids tool calls this turn; { tool } forces that one tool (the last turn must submit its answer). Default "auto". */
  toolChoice?: "auto" | "none" | { tool: string };
}
export interface ToolTurn {
  blocks: (TextBlock | ToolUseBlock)[];
  stopReason: string;
  usage: { input: number; output: number };
}
export type ToolTransport = (req: ToolTurnRequest) => Promise<ToolTurn>;

export function anthropicToolTransport(cfg: { apiKey: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string }): ToolTransport {
  const f = cfg.fetchImpl ?? fetch;
  return async ({ system, messages, tools, maxTokens, toolChoice }) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? 20_000);
    try {
      const res = await f(`${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages, tools, ...(toolChoice === "none" ? { tool_choice: { type: "none" } } : typeof toolChoice === "object" ? { tool_choice: { type: "tool", name: toolChoice.tool } } : {}) }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new LlmError(`the language-model request failed (HTTP ${res.status})`);
      const data = (await res.json()) as { content?: { type?: string; text?: string; id?: string; name?: string; input?: unknown }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      const blocks: ToolTurn["blocks"] = [];
      for (const b of data.content ?? []) {
        if (b.type === "text" && typeof b.text === "string") blocks.push({ type: "text", text: b.text });
        else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      return { blocks, stopReason: data.stop_reason ?? "", usage: { input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 } };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError(e instanceof Error && e.name === "AbortError" ? "the language-model request timed out" : "the language-model request failed");
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The ONE place a tool-use transport is built from configuration (same key and model as createModelTransport). Null without a key. */
export function createToolTransport(cfg: AiBrainConfig, opts: { timeoutMs?: number } = {}): ToolTransport | null {
  const key = cfg.apiKey;
  if (!key) return null;
  return anthropicToolTransport({ apiKey: key, model: cfg.llm.model, timeoutMs: opts.timeoutMs });
}
