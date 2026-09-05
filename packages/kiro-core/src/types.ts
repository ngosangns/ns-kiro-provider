// ABOUTME: Host-neutral vocabulary shared by every Kiro adapter.
// ABOUTME: Keeps the wire protocol independent of any one agent's message types.

/** User-facing reasoning levels, ordered least to most intensive. */
export type KiroEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const KIRO_EFFORT_ORDER: readonly KiroEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface KiroTextContent {
  type: "text";
  text: string;
}
export interface KiroImageContent {
  type: "image";
  /** Base64-encoded bytes, without a data-URL prefix. */
  data: string;
  mimeType: string;
}
export interface KiroThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}
export interface KiroToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type KiroUserContent = KiroTextContent | KiroImageContent;
export type KiroAssistantContent = KiroTextContent | KiroThinkingContent | KiroToolCallContent;

/** Why the previous assistant turn stopped; only `length` changes request shaping. */
export type KiroStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface KiroUserMessage {
  role: "user";
  content: KiroUserContent[];
}
export interface KiroAssistantMessage {
  role: "assistant";
  content: KiroAssistantContent[];
  stopReason?: KiroStopReason;
}
export interface KiroToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: KiroUserContent[];
  isError: boolean;
}

export type KiroMessage = KiroUserMessage | KiroAssistantMessage | KiroToolResultMessage;

/** One tool offered to the model, in JSON-schema form. */
export interface KiroTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface KiroCost {
  /** Cost per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One model as this provider needs to see it. Hosts carry richer descriptors;
 * an adapter projects theirs onto this before entering the core.
 */
export interface KiroModelSpec {
  /** Local id used for selection and cost attribution (e.g. `claude-sonnet-4-6`). */
  id: string;
  /** Wire id Kiro accepts, when it differs from {@link id}. */
  kiroModelId?: string;
  name: string;
  reasoning: boolean;
  /** Selectable efforts, least to most intensive. Absent means no effort control. */
  efforts?: readonly KiroEffort[];
  /** Effort to wire-value remap; identity for efforts the map omits. */
  effortMap?: Partial<Record<KiroEffort, string>>;
  /** Authenticated-catalog schema describing the effort field this model accepts. */
  additionalModelRequestFieldsSchema?: unknown;
  input: ("text" | "image")[];
  cost: KiroCost;
  contextWindow: number;
  maxTokens: number;
  /** Kiro API region this model is served from. */
  region?: string;
  /** Profile the request bills against, when the credential resolved one. */
  profileArn?: string;
}

export interface KiroUsage {
  input: number;
  output: number;
  totalTokens: number;
  /** Percentage of the context window Kiro reported for this turn. */
  contextPercent?: number;
  /**
   * Cached input tokens, present only when Kiro reports them. Absent means the
   * service said nothing about caching for this turn — not that nothing was
   * cached — so hosts should render it as unknown rather than zero.
   */
  cacheRead?: number;
  cacheWrite?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * What the core emits while a response streams. Block indexes are allocated
 * monotonically and never reused, so a consumer that ignores {@link KiroResetEvent}
 * still sees a well-formed, if longer, block sequence.
 */
export type KiroStreamEvent =
  | { type: "start" }
  | { type: "text_start"; index: number }
  | { type: "text_delta"; index: number; delta: string }
  | { type: "text_end"; index: number; text: string }
  | { type: "thinking_start"; index: number }
  | { type: "thinking_delta"; index: number; delta: string }
  | { type: "thinking_end"; index: number; thinking: string; signature?: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; id: string; argumentsDelta: string }
  | { type: "tool_call_end"; index: number; id: string; name: string; arguments: Record<string, unknown> }
  | KiroResetEvent
  | { type: "usage"; usage: KiroUsage }
  | { type: "done"; stopReason: "stop" | "toolUse" | "length" };

/**
 * An internal retry discarded everything emitted so far. Hosts able to drop
 * already-delivered blocks should; hosts that cannot may ignore this, because
 * the blocks that follow carry fresh indexes.
 */
export interface KiroResetEvent {
  type: "reset";
}
