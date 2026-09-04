// ABOUTME: Content-block bookkeeping shared by the stream and the thinking parser.
// ABOUTME: Owns index allocation and accumulation so hosts only mirror emitted events.

import type { KiroStreamEvent } from "./types.js";

type BlockKind = "text" | "thinking" | "toolCall";

interface Block {
  kind: BlockKind;
  text: string;
  ended: boolean;
}

/**
 * Allocates block indexes and accumulates their content while emitting the
 * neutral stream events for each transition.
 *
 * Indexes are monotonic across the whole response, including across an internal
 * retry: {@link reset} announces the discard but never rewinds the counter, so a
 * host that cannot drop delivered blocks still receives a coherent sequence.
 */
export class KiroBlockBuffer {
  private blocks = new Map<number, Block>();
  private nextIndex = 0;

  constructor(private readonly emit: (event: KiroStreamEvent) => void) {}

  openText(): number {
    const index = this.nextIndex++;
    this.blocks.set(index, { kind: "text", text: "", ended: false });
    this.emit({ type: "text_start", index });
    return index;
  }

  appendText(index: number, delta: string): void {
    const block = this.blocks.get(index);
    if (!block || !delta) return;
    block.text += delta;
    this.emit({ type: "text_delta", index, delta });
  }

  endText(index: number): void {
    const block = this.blocks.get(index);
    if (!block || block.ended) return;
    block.ended = true;
    this.emit({ type: "text_end", index, text: block.text });
  }

  openThinking(): number {
    const index = this.nextIndex++;
    this.blocks.set(index, { kind: "thinking", text: "", ended: false });
    this.emit({ type: "thinking_start", index });
    return index;
  }

  appendThinking(index: number, delta: string): void {
    const block = this.blocks.get(index);
    if (!block || !delta) return;
    block.text += delta;
    this.emit({ type: "thinking_delta", index, delta });
  }

  endThinking(index: number, signature?: string): void {
    const block = this.blocks.get(index);
    if (!block || block.ended) return;
    block.ended = true;
    this.emit({ type: "thinking_end", index, thinking: block.text, ...(signature ? { signature } : {}) });
  }

  /** Reserve an index for a block this buffer does not accumulate (a tool call). */
  reserve(): number {
    const index = this.nextIndex++;
    this.blocks.set(index, { kind: "toolCall", text: "", ended: true });
    return index;
  }

  getText(index: number): string {
    return this.blocks.get(index)?.text ?? "";
  }

  /**
   * Rewrite one accumulated block before it is closed. Used by the recovery
   * passes that lift tool calls out of text and by echo-noise stripping, both
   * of which decide only once the whole response has arrived.
   */
  setText(index: number, text: string): void {
    const block = this.blocks.get(index);
    if (block) block.text = text;
  }

  /** Announce that an internal retry discarded everything emitted so far. */
  reset(): void {
    this.blocks.clear();
    this.emit({ type: "reset" });
  }
}
