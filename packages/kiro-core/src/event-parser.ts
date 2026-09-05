// ABOUTME: Kiro stream event type definitions and JSON-to-typed-event mapping.
// ABOUTME: Binary framing is handled by @smithy/core EventStreamMarshaller in stream.ts.
// Named `KiroWireEvent` to keep it distinct from `KiroStreamEvent`, which is what
// this package emits outward after parsing.

export type KiroWireEvent =
  | { type: "content"; data: string }
  | { type: "thinkingText"; data: string }
  | { type: "thinkingSignature"; data: string }
  | { type: "toolUse"; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
  | { type: "toolUseInput"; data: { input: string } }
  | { type: "toolUseStop"; data: { stop: boolean } }
  | { type: "contextUsage"; data: { contextUsagePercentage: number } }
  | { type: "followupPrompt"; data: string }
  | { type: "usage"; data: KiroWireUsage }
  | { type: "error"; data: { error: string; message?: string } };

/**
 * Token counts from a `usage` frame. Every field is optional because Kiro does
 * not emit the frame on every turn, and emits only a subset when it does.
 *
 * Whether Kiro reports cache counts at all is unconfirmed, and its request
 * schema exposes no way to ask for caching — so the cache fields are read from
 * the spellings its upstreams use (Bedrock's `cacheReadInputTokens`,
 * Anthropic's `cache_read_input_tokens`) rather than one assumed name. An
 * absent count stays `undefined` rather than becoming `0`, so a consumer can
 * tell "nothing was cached" apart from "the service said nothing about cache".
 * Set `KIRO_DEBUG=1` to log the frame verbatim and settle the question.
 */
export interface KiroWireUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Accept only a finite, non-negative count; anything else is treated as absent. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstTokenCount(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const count = tokenCount(source[key]);
    if (count !== undefined) return count;
  }
  return undefined;
}

const CACHE_READ_KEYS = ["cacheReadInputTokens", "cache_read_input_tokens", "cacheReadTokens"] as const;
const CACHE_WRITE_KEYS = [
  "cacheWriteInputTokens",
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cacheWriteTokens",
] as const;

export function parseKiroEvent(parsed: Record<string, unknown>): KiroWireEvent | null {
  if (parsed.content !== undefined) return { type: "content", data: parsed.content as string };
  if (typeof parsed.text === "string") return { type: "thinkingText", data: parsed.text };
  if (typeof parsed.signature === "string") return { type: "thinkingSignature", data: parsed.signature };
  if (parsed.name && parsed.toolUseId) {
    const input =
      typeof parsed.input === "string"
        ? parsed.input
        : parsed.input &&
            typeof parsed.input === "object" &&
            Object.keys(parsed.input as Record<string, unknown>).length > 0
          ? JSON.stringify(parsed.input)
          : "";
    return {
      type: "toolUse",
      data: {
        name: parsed.name as string,
        toolUseId: parsed.toolUseId as string,
        input,
        stop: parsed.stop as boolean | undefined,
      },
    };
  }
  if (parsed.input !== undefined && !parsed.name) {
    return {
      type: "toolUseInput",
      data: { input: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input) },
    };
  }
  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined)
    return { type: "toolUseStop", data: { stop: parsed.stop as boolean } };
  if (parsed.contextUsagePercentage !== undefined)
    return { type: "contextUsage", data: { contextUsagePercentage: parsed.contextUsagePercentage as number } };
  if (parsed.followupPrompt !== undefined) return { type: "followupPrompt", data: parsed.followupPrompt as string };
  if (parsed.error !== undefined || parsed.Error !== undefined) {
    const error = (parsed.error || parsed.Error || "unknown") as string;
    const message = (parsed.message || parsed.Message || parsed.reason) as string | undefined;
    return { type: "error", data: { error: typeof error === "string" ? error : JSON.stringify(error), message } };
  }
  if (parsed.usage !== undefined) {
    const u = parsed.usage as Record<string, unknown>;
    const cacheReadTokens = firstTokenCount(u, CACHE_READ_KEYS);
    const cacheWriteTokens = firstTokenCount(u, CACHE_WRITE_KEYS);
    return {
      type: "usage",
      data: {
        inputTokens: tokenCount(u.inputTokens),
        outputTokens: tokenCount(u.outputTokens),
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      },
    };
  }
  return null;
}
