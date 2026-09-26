// ABOUTME: Turns Kiro wire events into neutral content blocks and a stop reason.
// ABOUTME: Owns what the response says; the request loop owns whether to ask again.

import { KiroBlockBuffer } from "./blocks.js";
import { parseBracketToolCalls } from "./bracket-tool-parser.js";
import { calculateKiroCost } from "./cost.js";
import { debugEnabled, debugLog, formatSafeError, redactSensitiveText } from "./debug.js";
import type { KiroWireUsage } from "./event-parser.js";
import { parseInvokeToolCalls } from "./invoke-tool-parser.js";
import type { KiroModel } from "./models.js";
import type { KiroWireEventFrame } from "./response-stream.js";
import { ThinkingTagParser } from "./thinking-parser.js";
import { countTokens } from "./tokenizer.js";
import type { KiroStreamEvent, KiroUsage } from "./types.js";

/** Text that is an artifact of history padding rather than an answer. */
const ECHO_NOISE_PATTERN = /^\s*(continue|\.+)\s*$/i;

interface KiroToolCallState {
  toolUseId: string;
  name: string;
  input: string;
}

/** What the finished attempt produced, before the caller decides to keep it. */
export interface KiroAttemptSummary {
  responseText: string;
  hasText: boolean;
  sawAnyToolCalls: boolean;
  emittedToolCalls: number;
  /** The whole turn is a "Continue" echo taught by synthetic padding. */
  isEchoLoop: boolean;
  /** No text and no tool calls: a 200 that said nothing. */
  isEmpty: boolean;
  /**
   * Resolved as soon as the attempt's inputs are final so an exhaustion
   * diagnostic can report the value actually assigned.
   */
  stopReason: "stop" | "toolUse" | "length";
  /**
   * Names of tool calls `emitToolCall` refused because their arguments would
   * not parse. Per-attempt, like `emittedToolCalls`: a retry must not inherit
   * a discarded attempt's drops.
   */
  droppedToolCalls: unknown[];
}

export interface KiroCompletedResponse {
  stopReason: "stop" | "toolUse" | "length";
  usage: KiroUsage;
  /** Wire usage as received, for callers running usage estimates. */
  wireUsage: KiroWireUsage | null;
  /** The turn's credit metering frame, when Kiro sent one. */
  metering: { credits?: number; unit?: string; unitPlural?: string } | null;
}

/**
 * Accumulates one response.
 *
 * Block indexes are monotonic across the whole call, including across an
 * internal retry, so the buffer outlives a single attempt while everything
 * else — including the usage figures — is reset by {@link beginAttempt}:
 * a discarded attempt must not bill the turn that replaced it.
 */
export class KiroResponseAssembler {
  private readonly pending: KiroStreamEvent[] = [];
  private readonly blocks = new KiroBlockBuffer((event) => this.pending.push(event));
  private readonly usage: KiroUsage = {
    input: 0,
    output: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  private totalContent = "";
  private lastContentData = "";
  private usageEvent: KiroWireUsage | null = null;
  private meteringEvent: { credits?: number; unit?: string; unitPlural?: string } | null = null;
  private receivedContextUsage = false;
  private thinkingParser: ThinkingTagParser | null = null;
  private nativeThinkingBlockIndex: number | null = null;
  private nativeThinkingEnded = false;
  private textBlockIndex: number | null = null;
  private emittedToolCalls = 0;
  private sawAnyToolCalls = false;
  private droppedToolCalls: unknown[] = [];
  private currentToolCall: KiroToolCallState | null = null;
  private stopReason: "stop" | "toolUse" | "length" = "stop";

  constructor(
    private readonly model: KiroModel,
    private readonly thinkingEnabled: boolean,
    /**
     * Wire name → host name for tools `toKiroToolName` had to rename on the
     * request. Applied at ingest so every downstream read — emitted events and
     * the dropped-call diagnostic alike — reports the name the host
     * registered, not the alias the wire required.
     */
    private readonly toolNameAliases?: ReadonlyMap<string, string>,
  ) {}

  private originalToolName(name: string): string {
    return this.toolNameAliases?.get(name) ?? name;
  }

  /** Clear per-attempt state. Only block indexes are kept. */
  beginAttempt(): void {
    this.totalContent = "";
    this.lastContentData = "";
    this.usageEvent = null;
    this.meteringEvent = null;
    this.receivedContextUsage = false;
    this.thinkingParser = this.thinkingEnabled ? new ThinkingTagParser(this.blocks) : null;
    this.nativeThinkingBlockIndex = null;
    this.nativeThinkingEnded = false;
    this.textBlockIndex = null;
    this.emittedToolCalls = 0;
    this.sawAnyToolCalls = false;
    this.droppedToolCalls = [];
    this.currentToolCall = null;
    // Every wire-derived usage figure lives on `usage`, which outlives the
    // retry loop, so an abandoned attempt's accounting would otherwise be
    // billed to the turn that replaced it.
    this.usage.input = 0;
    this.usage.output = 0;
    this.usage.totalTokens = 0;
    this.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    // Optional fields stay absent rather than 0: absent means "the service did
    // not report it", which a retried turn must not overwrite with a stale or
    // invented figure.
    delete this.usage.cacheRead;
    delete this.usage.cacheWrite;
    delete this.usage.contextPercent;
    delete this.usage.credits;
    delete this.usage.creditUnit;
  }

  /** Hand over the events buffered so far. */
  takeEvents(): KiroStreamEvent[] {
    return this.pending.splice(0, this.pending.length);
  }

  /** Announce that a retry discarded everything emitted so far. */
  discard(): void {
    this.blocks.reset();
    this.textBlockIndex = null;
  }

  handle(frame: KiroWireEventFrame): void {
    const { event, payload } = frame;
    switch (event.type) {
      case "contextUsage": {
        const pct = event.data.contextUsagePercentage;
        this.usage.input = Math.round((pct / 100) * this.model.contextWindow);
        this.usage.contextPercent = pct;
        this.receivedContextUsage = true;
        break;
      }
      case "thinkingText": {
        if (!this.thinkingEnabled) break;
        this.blocks.appendThinking(this.ensureNativeThinkingBlock(), event.data);
        this.totalContent += event.data;
        break;
      }
      case "thinkingSignature": {
        if (!this.thinkingEnabled) break;
        this.ensureNativeThinkingBlock();
        this.endNativeThinking(event.data);
        break;
      }
      case "content": {
        this.endNativeThinking();
        // Kiro repeats the last content frame on some turns; a repeat carries no
        // new text and must not be appended twice.
        if (event.data === this.lastContentData) break;
        this.lastContentData = event.data;
        this.totalContent += event.data;
        if (this.thinkingParser) {
          this.thinkingParser.processChunk(event.data);
        } else {
          if (this.textBlockIndex === null) this.textBlockIndex = this.blocks.openText();
          this.blocks.appendText(this.textBlockIndex, event.data);
        }
        break;
      }
      case "toolUse": {
        const tc = event.data;
        this.sawAnyToolCalls = true;
        if (!this.currentToolCall || this.currentToolCall.toolUseId !== tc.toolUseId) {
          this.flushToolCall();
          this.currentToolCall = { toolUseId: tc.toolUseId, name: this.originalToolName(tc.name), input: "" };
        }
        this.currentToolCall.input += tc.input || "";
        if (tc.input) this.totalContent += tc.input;
        if (tc.stop) this.flushToolCall();
        break;
      }
      case "toolUseInput": {
        if (this.currentToolCall) this.currentToolCall.input += event.data.input || "";
        if (event.data.input) this.totalContent += event.data.input;
        break;
      }
      case "toolUseStop": {
        if (event.data.stop) this.flushToolCall();
        break;
      }
      case "usage": {
        // Every metadataEvent field is optional, so the service may split
        // tokenUsage and stopReason/stopDetails across frames. Merge so a
        // later partial frame cannot erase counts already received.
        this.usageEvent = { ...(this.usageEvent ?? {}), ...event.data };
        // The parsed event keeps only the fields this package understands.
        // Log the frame verbatim so a field Kiro adds — cache counters above
        // all — is visible without having to guess its name first.
        if (debugEnabled()) debugLog("response.usageRaw", payload);
        break;
      }
      case "metering": {
        this.meteringEvent = event.data;
        if (debugEnabled()) debugLog("stream.metering", [event.data]);
        break;
      }
      // followupPrompt events are intentionally ignored
    }
  }

  /**
   * Close the turn: flush a trailing tool call, close thinking, and run the
   * text-dialect recovery and echo-stripping passes.
   */
  endTurn(): KiroAttemptSummary {
    if (this.currentToolCall) {
      if (this.emitToolCall(this.currentToolCall)) this.emittedToolCalls++;
      else this.droppedToolCalls.push(this.currentToolCall.name);
    }
    this.currentToolCall = null;
    this.endNativeThinking();
    if (this.thinkingParser) {
      this.thinkingParser.finalize();
      this.textBlockIndex = this.thinkingParser.getTextBlockIndex();
    }

    // Deliberately still gated on `sawAnyToolCalls`, so it does NOT run when a
    // native call arrived and was dropped for unparseable arguments. Widening it
    // to `emittedToolCalls === 0` would enable text recovery on exactly the path
    // where `KiroModel.recoverTextToolCalls === false` says not to (Claude). The
    // drop is reported instead via `droppedToolCalls`.
    this.recoverTextToolCalls();
    this.stripEchoNoise();

    const responseText = this.textBlockIndex === null ? "" : this.blocks.getText(this.textBlockIndex);
    const hasText = responseText.length > 0;
    // Resolved here — before the caller's retry-exhaustion warnings — so those
    // diagnostics can report the value actually assigned. It reads only
    // `receivedContextUsage` and `emittedToolCalls`, both final at this point.
    //
    // Use `emittedToolCalls`, not the count seen on the wire: a turn whose calls
    // were all dropped for unparseable input must not report `toolUse`, because
    // an empty turn with a tool-use stop stalls an agent loop waiting for
    // results that will never arrive.
    //
    // `length` is inferred, not reported: Kiro sends no stop reason, so a turn
    // that produced no tool call and never carried a contextUsage frame is
    // treated as cut short.
    this.stopReason =
      !this.receivedContextUsage && this.emittedToolCalls === 0
        ? "length"
        : this.emittedToolCalls > 0
          ? "toolUse"
          : "stop";
    return {
      responseText,
      hasText,
      sawAnyToolCalls: this.sawAnyToolCalls,
      emittedToolCalls: this.emittedToolCalls,
      isEchoLoop: hasText && !this.sawAnyToolCalls && ECHO_NOISE_PATTERN.test(responseText),
      isEmpty: !hasText && !this.sawAnyToolCalls,
      stopReason: this.stopReason,
      droppedToolCalls: this.droppedToolCalls,
    };
  }

  /** Drop an echo the caller decided not to retry, so it is not read as a continuation signal. */
  stripEcho(): void {
    if (this.textBlockIndex !== null) this.blocks.setText(this.textBlockIndex, "");
  }

  /** Kinds of the blocks this attempt produced, for the exhaustion diagnostic. */
  contentKinds(): string[] {
    return this.blocks.kinds();
  }

  /** Close the text block and settle usage and the stop reason. */
  complete(): KiroCompletedResponse {
    if (this.textBlockIndex !== null) this.blocks.endText(this.textBlockIndex);

    // Kiro does not reliably emit per-response output token counts. When the
    // `usage` event is missing or reports only `inputTokens`, fall back to a
    // tiktoken estimate over everything the assistant emitted — text plus
    // tool-call input JSON. Otherwise tool-call-only turns report 0 output
    // tokens and break consumers that watch it.
    // `KiroWireUsage.inputTokens` is `TokenUsage.uncachedInputTokens` — the
    // input billed at full rate, NOT total input — with the cache counts as
    // siblings, so the cache counts must land whenever `input` is taken from
    // the wire; otherwise a cached turn reports a fraction of its real input.
    if (this.usageEvent?.inputTokens !== undefined) this.usage.input = this.usageEvent.inputTokens;
    this.usage.output = this.usageEvent?.outputTokens ?? countTokens(this.totalContent);
    // `TokenUsage.totalTokens` is required on the wire while the cache counts
    // are optional, so the service's own total is the authoritative figure —
    // recomputing from components silently under-reports whenever a component
    // is omitted. Prefer it and fall back to the sum.
    this.usage.totalTokens =
      this.usageEvent?.totalTokens ??
      this.usage.input +
        (this.usageEvent?.cacheReadInputTokens ?? 0) +
        (this.usageEvent?.cacheWriteInputTokens ?? 0) +
        this.usage.output;
    // Only set when reported: leaving these absent is what tells a host that
    // Kiro said nothing about caching, rather than that nothing was cached.
    if (this.usageEvent?.cacheReadInputTokens !== undefined)
      this.usage.cacheRead = this.usageEvent.cacheReadInputTokens;
    if (this.usageEvent?.cacheWriteInputTokens !== undefined)
      this.usage.cacheWrite = this.usageEvent.cacheWriteInputTokens;
    // The metering frame is the only usage figure Kiro actually sends: a
    // credit count, not tokens.
    if (this.meteringEvent?.credits !== undefined) this.usage.credits = this.meteringEvent.credits;
    if (this.meteringEvent?.unit !== undefined) this.usage.creditUnit = this.meteringEvent.unit;
    this.usage.cost = calculateKiroCost(this.model.cost, this.usage);

    const stopReason = this.stopReason;
    //
    // The `length` heuristic rests on contextUsage closing every complete
    // response. Checked 2026-09-06 across a short reply, a ~5000-character one,
    // a tool-call turn, a model with no effort schema (claude-haiku-4.5) and a
    // non-Claude model (glm-5): the frame arrived in all five, so its absence
    // really does mark an abnormal turn. `response.done` logs
    // `receivedContextUsage` in case a later Kiro stops sending it — a false
    // `length` is read by hosts as truncation and prepends TRUNCATION_NOTICE,
    // asking the model to continue work it already finished.

    debugLog("response.done", {
      stopReason,
      receivedContextUsage: this.receivedContextUsage,
      emittedToolCalls: this.emittedToolCalls,
      sawAnyToolCalls: this.sawAnyToolCalls,
      textLen: this.textBlockIndex === null ? 0 : this.blocks.getText(this.textBlockIndex).length,
      usage: this.usage,
    });

    return {
      stopReason,
      usage: this.usage,
      wireUsage: this.usageEvent,
      metering: this.meteringEvent,
    };
  }

  private ensureNativeThinkingBlock(): number {
    if (this.nativeThinkingBlockIndex === null) this.nativeThinkingBlockIndex = this.blocks.openThinking();
    return this.nativeThinkingBlockIndex;
  }

  private endNativeThinking(signature?: string): void {
    if (this.nativeThinkingBlockIndex === null || this.nativeThinkingEnded) return;
    this.nativeThinkingEnded = true;
    this.blocks.endThinking(this.nativeThinkingBlockIndex, signature);
  }

  private emitToolCall(state: KiroToolCallState): boolean {
    if (!state.input.trim()) {
      // Kiro omits the input payload when the model calls a tool with no
      // arguments (e.g. `mcp({})`). Treat empty input as an empty object
      // rather than skipping — these are valid zero-arg calls, not truncations.
      state.input = "{}";
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(state.input) as Record<string, unknown>;
    } catch (e) {
      // Returning false drops the call: nothing is emitted for it, so the call
      // the model made never reaches the agent. Callers record the name in
      // `droppedToolCalls` so the turn can carry a diagnostic about it — a
      // console warning is invisible to whoever reads the transcript.
      console.warn(
        `[kiro-core] Failed to parse tool input for "${state.name}" (toolUseId: ${state.toolUseId}): ${formatSafeError(e)}. Raw input (${state.input.length} chars): ${redactSensitiveText(state.input.substring(0, 200))}`,
      );
      return false;
    }
    const index = this.blocks.reserve();
    this.pending.push({ type: "tool_call_start", index, id: state.toolUseId, name: state.name });
    this.pending.push({ type: "tool_call_delta", index, id: state.toolUseId, argumentsDelta: state.input });
    this.pending.push({ type: "tool_call_end", index, id: state.toolUseId, name: state.name, arguments: args });
    return true;
  }

  private flushToolCall(): void {
    if (!this.currentToolCall) return;
    if (this.emitToolCall(this.currentToolCall)) this.emittedToolCalls++;
    else this.droppedToolCalls.push(this.currentToolCall.name);
    this.currentToolCall = null;
  }

  /**
   * Extract text-dialect tool calls from content when no native tool calls
   * arrived. Two dialects are recovered at this seam:
   *   1. Kiro's own `[Called name with args: {...}]` bracket form.
   *   2. Anthropic's `<invoke name="..."><parameter .../></invoke>` XML form,
   *      which opus-class models emit as plain text at high context.
   * Without this, the turn ends `stop` with zero tool calls — the agent loop
   * sees a finished answer and an unattended session stalls with no error
   * recorded anywhere.
   *
   * Models that emit native tool-use events opt out via
   * `recoverTextToolCalls: false`. For them this pass has nothing to rescue
   * and everything to break: prose that merely *quotes* the syntax — a model
   * explaining how a tool is called — would be lifted into a real call the
   * model never made. Absent means recover, so a model the catalog says
   * nothing about keeps the fallback.
   */
  private recoverTextToolCalls(): void {
    if (this.model.recoverTextToolCalls === false || this.sawAnyToolCalls || this.textBlockIndex === null) return;

    let text = this.blocks.getText(this.textBlockIndex);
    const recovered: Array<{ toolUseId: string; name: string; arguments: Record<string, unknown> }> = [];
    const bracketResult = parseBracketToolCalls(text);
    if (bracketResult.toolCalls.length > 0) {
      text = bracketResult.cleanedText;
      recovered.push(...bracketResult.toolCalls);
    }
    const invokeResult = parseInvokeToolCalls(text);
    if (invokeResult.toolCalls.length > 0) {
      text = invokeResult.cleanedText;
      recovered.push(...invokeResult.toolCalls);
    }
    if (recovered.length === 0) return;

    this.blocks.setText(this.textBlockIndex, text);
    this.sawAnyToolCalls = true;
    for (const call of recovered) {
      if (
        this.emitToolCall({
          toolUseId: call.toolUseId,
          name: this.originalToolName(call.name),
          input: JSON.stringify(call.arguments),
        })
      ) {
        this.emittedToolCalls++;
      } else {
        // Unreachable as written, and kept deliberately. Both dialects hand
        // over an in-memory object — bracket-tool-parser's is itself a
        // successful `JSON.parse` result, invoke-tool-parser's is a record of
        // raw parameter strings — so `JSON.stringify` of either always
        // round-trips and `emitToolCall`'s only `false` return, a
        // `JSON.parse` throw, cannot fire here. It stays so that a future
        // parser change passing raw text through cannot silently reintroduce
        // the very dropped-call blindness this change exists to remove.
        this.droppedToolCalls.push(this.originalToolName(call.name));
      }
    }
  }

  /**
   * Strip echo noise: when tool calls are present and the text content is just
   * "." or a similar short echo from history padding, remove it. This prevents
   * the echo from accumulating in conversation history and reinforcing the
   * pattern in future turns.
   */
  private stripEchoNoise(): void {
    if (this.emittedToolCalls === 0 || this.textBlockIndex === null) return;
    if (ECHO_NOISE_PATTERN.test(this.blocks.getText(this.textBlockIndex))) {
      this.blocks.setText(this.textBlockIndex, "");
    }
  }
}
