// ABOUTME: Drives kiro-core's neutral event stream into OMP's AssistantMessageEventStream.
// ABOUTME: Owns message assembly; the core owns the wire protocol and every retry.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@oh-my-pi/pi-ai";
import * as PiAi from "@oh-my-pi/pi-ai";
import {
  formatSafeError,
  getCachedModels,
  getKiroRegionFromEndpoint,
  type KiroEffort,
  type KiroModel,
  streamKiro,
} from "ns-kiro-core";
import { resolveRequestCredentials } from "./auth.js";
import { toKiroMessages, toKiroTools } from "./messages.js";

/** Catalog metadata this provider attaches to the models it registers. */
export type KiroBackedModel = Model<Api> & {
  kiroModelId?: string;
  kiroRegion?: string;
  kiroProfileArn?: string;
  additionalModelRequestFieldsSchema?: Record<string, unknown>;
};

/**
 * pi-ai's barrel re-exports the stream class as type-only ahead of the runtime
 * class, so a named import resolves to a type. Read the constructor off the
 * namespace instead, and fall back to the factory omp still ships for older
 * extensions when the class itself is not exported.
 */
function newEventStream(): AssistantMessageEventStream {
  const runtime = PiAi as unknown as {
    AssistantMessageEventStream?: new () => AssistantMessageEventStream;
    createAssistantMessageEventStream?: () => AssistantMessageEventStream;
  };
  if (typeof runtime.AssistantMessageEventStream === "function") return new runtime.AssistantMessageEventStream();
  if (typeof runtime.createAssistantMessageEventStream === "function") {
    return runtime.createAssistantMessageEventStream();
  }
  throw new Error("This omp build exposes no AssistantMessageEventStream; omp-provider-kiro needs omp >= 18.1.");
}

const ZERO_USAGE = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * Rebuild the core's model descriptor from what OMP hands back at request time.
 *
 * OMP's registry keeps its own `Model`, built from the config this provider
 * registered, so the catalog entry is looked up again here rather than carried
 * through: the ladder and the request-fields schema decide effort mapping, and
 * a request must use the same ones the catalog advertised.
 *
 * Looks up the region's authenticated cache, not the static bootstrap list:
 * models discovered only through the authenticated catalog (no bootstrap
 * entry) would otherwise miss this lookup and fall through to guessing a wire
 * id from the dash-spelled local `id`, which Kiro rejects as `INVALID_MODEL_ID`.
 */
export function toKiroModel(model: KiroBackedModel, region: string): KiroModel {
  const known = getCachedModels(region).find((candidate) => candidate.id === model.id);
  return {
    ...(known ?? {
      id: model.id,
      // No fallback to `model.id`: that dash-spelled local id is not a valid
      // Kiro wire id. Falls back to `""` rather than `model.id` — falsy, so
      // `resolveKiroModel`'s `if (exactKiroModelId) return exactKiroModelId`
      // treats it as no override and runs its own cache/bootstrap/dot-normalize
      // resolution instead of being short-circuited by a value that is really
      // just `model.id` again.
      kiroModelId: model.kiroModelId ?? "",
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      cost: { ...model.cost },
      contextWindow: model.contextWindow ?? 200_000,
      maxTokens: model.maxTokens ?? 8_192,
    }),
    region,
    ...(model.kiroProfileArn ? { profileArn: model.kiroProfileArn } : {}),
    ...(model.additionalModelRequestFieldsSchema
      ? { additionalModelRequestFieldsSchema: model.additionalModelRequestFieldsSchema }
      : {}),
  };
}

export function streamKiroForOmp(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = newEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const hostKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
      const credentials = await resolveRequestCredentials(hostKey);

      // Core block indexes are monotonic across the whole response, including
      // across an internal retry; OMP's are positions in `output.content`, which
      // a retry rewinds. Keep the translation rather than assuming they agree.
      let indexes = new Map<number, number>();
      const open = (coreIndex: number, block: AssistantMessage["content"][number]): number => {
        const contentIndex = output.content.length;
        output.content.push(block);
        indexes.set(coreIndex, contentIndex);
        return contentIndex;
      };
      const at = (coreIndex: number): number | undefined => indexes.get(coreIndex);

      const region =
        (model as KiroBackedModel).kiroRegion ?? getKiroRegionFromEndpoint(model.baseUrl) ?? credentials.region;
      for await (const event of streamKiro({
        model: toKiroModel(model as KiroBackedModel, region),
        messages: toKiroMessages(context.messages),
        systemPrompt: context.systemPrompt?.join("\n\n"),
        tools: toKiroTools(context.tools),
        effort: options?.reasoning as KiroEffort | undefined,
        accessToken: credentials.accessToken,
        sessionId: options?.sessionId,
        signal: options?.signal,
        profileArn: (model as KiroBackedModel).kiroProfileArn ?? credentials.profileArn,
        // OMP renders from `partial`, so discarding blocks is a matter of
        // truncating the array the renderer already reads.
        canDiscardEmittedBlocks: true,
      })) {
        switch (event.type) {
          case "start":
            stream.push({ type: "start", partial: output });
            break;
          case "reset":
            output.content = [];
            indexes = new Map();
            break;
          case "text_start": {
            const contentIndex = open(event.index, { type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex, partial: output });
            break;
          }
          case "text_delta": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            (output.content[contentIndex] as TextContent).text += event.delta;
            stream.push({ type: "text_delta", contentIndex, delta: event.delta, partial: output });
            break;
          }
          case "text_end": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            // The core rewrites a block's text after the fact when it lifts tool
            // calls out of prose or strips echo noise, so the terminal event —
            // not the accumulated deltas — is the authority on final content.
            (output.content[contentIndex] as TextContent).text = event.text;
            stream.push({ type: "text_end", contentIndex, content: event.text, partial: output });
            break;
          }
          case "thinking_start": {
            const contentIndex = open(event.index, { type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex, partial: output });
            break;
          }
          case "thinking_delta": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            (output.content[contentIndex] as ThinkingContent).thinking += event.delta;
            stream.push({ type: "thinking_delta", contentIndex, delta: event.delta, partial: output });
            break;
          }
          case "thinking_end": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            const block = output.content[contentIndex] as ThinkingContent;
            block.thinking = event.thinking;
            if (event.signature) block.thinkingSignature = event.signature;
            stream.push({ type: "thinking_end", contentIndex, content: event.thinking, partial: output });
            break;
          }
          case "tool_call_start": {
            const toolCall: ToolCall = { type: "toolCall", id: event.id, name: event.name, arguments: {} };
            const contentIndex = open(event.index, toolCall);
            stream.push({ type: "toolcall_start", contentIndex, partial: output });
            break;
          }
          case "tool_call_delta": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            stream.push({ type: "toolcall_delta", contentIndex, delta: event.argumentsDelta, partial: output });
            break;
          }
          case "tool_call_end": {
            const contentIndex = at(event.index);
            if (contentIndex === undefined) break;
            const toolCall = output.content[contentIndex] as ToolCall;
            toolCall.arguments = event.arguments;
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
            break;
          }
          case "usage": {
            output.usage.input = event.usage.input;
            output.usage.output = event.usage.output;
            output.usage.totalTokens = event.usage.totalTokens;
            // OMP's usage fields are required numbers, so an unreported cache
            // count collapses to 0 here — the distinction the core preserves
            // cannot be expressed on this side.
            output.usage.cacheRead = event.usage.cacheRead ?? 0;
            output.usage.cacheWrite = event.usage.cacheWrite ?? 0;
            output.usage.cost = { ...event.usage.cost };
            if (event.usage.contextPercent !== undefined) {
              (output.usage as unknown as Record<string, unknown>).contextPercent = event.usage.contextPercent;
            }
            break;
          }
          case "done":
            output.stopReason = event.stopReason;
            stream.push({ type: "done", reason: event.stopReason, message: output });
            break;
        }
      }
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatSafeError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })().catch(() => {
    // Safety net: catch any rejection that escapes the inner try/catch (an
    // AbortError during signal teardown, say). Without this the fire-and-forget
    // IIFE produces an unhandled rejection that crashes the host.
    try {
      stream.end();
    } catch {}
  });

  return stream;
}
