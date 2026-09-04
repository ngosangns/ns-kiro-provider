// ABOUTME: Stateful parser for thinking tags in streaming content.
// ABOUTME: Separates thinking blocks from text, supporting multiple tag variants.

import type { KiroBlockBuffer } from "./blocks.js";

export const THINKING_START_TAG = "<thinking>";
export const THINKING_END_TAG = "</thinking>";

// All recognized thinking tag variants and their corresponding close tags
const THINKING_TAG_VARIANTS: Array<{ open: string; close: string }> = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "<think>", close: "</think>" },
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thought>", close: "</thought>" },
];

function getTrailingPossibleTagPrefixLength(text: string, tag: string): number {
  const maxPrefixLength = Math.min(text.length, tag.length - 1);
  for (let len = maxPrefixLength; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

function getMaxTrailingPossibleTagPrefixLength(text: string, tags: string[]): number {
  let maxLength = 0;
  for (const tag of tags) {
    maxLength = Math.max(maxLength, getTrailingPossibleTagPrefixLength(text, tag));
  }
  return maxLength;
}

export class ThinkingTagParser {
  private textBuffer = "";
  private inThinking = false;
  private thinkingBlockIndex: number | null = null;
  private textBlockIndex: number | null = null;
  private lastTextBlockIndex: number | null = null;
  private activeEndTag: string = THINKING_END_TAG;

  constructor(private readonly blocks: KiroBlockBuffer) {}

  processChunk(chunk: string): void {
    this.textBuffer += chunk;
    while (this.textBuffer.length > 0) {
      const prevLength = this.textBuffer.length;
      if (!this.inThinking) {
        this.processBeforeThinking();
        if (this.textBuffer.length === 0) break;
      }
      if (this.inThinking) {
        this.processInsideThinking();
        if (this.textBuffer.length === 0) break;
      }
      // No progress: the remainder is a held-back partial tag prefix.
      if (this.textBuffer.length >= prevLength) break;
    }
  }

  finalize(): void {
    if (this.textBuffer.length === 0) return;
    if (this.inThinking && this.thinkingBlockIndex !== null) {
      this.blocks.appendThinking(this.thinkingBlockIndex, this.textBuffer);
      this.blocks.endThinking(this.thinkingBlockIndex);
    } else {
      this.emitText(this.textBuffer);
    }
    this.textBuffer = "";
  }

  getTextBlockIndex(): number | null {
    return this.textBlockIndex ?? this.lastTextBlockIndex;
  }

  private processBeforeThinking(): void {
    let bestPos = -1;
    let bestVariant: (typeof THINKING_TAG_VARIANTS)[number] | null = null;
    for (const variant of THINKING_TAG_VARIANTS) {
      const pos = this.textBuffer.indexOf(variant.open);
      if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
        bestPos = pos;
        bestVariant = variant;
      }
    }
    if (bestPos !== -1 && bestVariant) {
      if (bestPos > 0) this.emitText(this.textBuffer.slice(0, bestPos));
      this.textBuffer = this.textBuffer.slice(bestPos + bestVariant.open.length);
      this.activeEndTag = bestVariant.close;
      this.inThinking = true;
      return;
    }

    const trailingPrefixLength = getMaxTrailingPossibleTagPrefixLength(
      this.textBuffer,
      THINKING_TAG_VARIANTS.map((variant) => variant.open),
    );
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitText(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private processInsideThinking(): void {
    const endPos = this.textBuffer.indexOf(this.activeEndTag);
    if (endPos !== -1) {
      if (endPos > 0) this.emitThinking(this.textBuffer.slice(0, endPos));
      const thinkingBlockIndex = this.ensureThinkingBlock();
      this.blocks.endThinking(thinkingBlockIndex);
      this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length);
      this.inThinking = false;
      // Reset so a later region in the same message opens its own thinking
      // block instead of appending to this one.
      this.thinkingBlockIndex = null;
      this.activeEndTag = THINKING_END_TAG;
      // Only advance the remembered index: back-to-back regions with no text
      // between them would otherwise clobber a real index with null, and
      // `getTextBlockIndex()` would report no text block to the stream.
      if (this.textBlockIndex !== null) this.lastTextBlockIndex = this.textBlockIndex;
      this.textBlockIndex = null;
      if (this.textBuffer.startsWith("\n\n")) this.textBuffer = this.textBuffer.slice(2);
      return;
    }

    const trailingPrefixLength = getTrailingPossibleTagPrefixLength(this.textBuffer, this.activeEndTag);
    const safeLen = this.textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      this.emitThinking(this.textBuffer.slice(0, safeLen));
      this.textBuffer = this.textBuffer.slice(safeLen);
    }
  }

  private emitText(text: string): void {
    if (!text) return;
    if (this.textBlockIndex === null) this.textBlockIndex = this.blocks.openText();
    this.blocks.appendText(this.textBlockIndex, text);
  }

  private ensureThinkingBlock(): number {
    if (this.thinkingBlockIndex !== null) return this.thinkingBlockIndex;
    // Always append, never splice: blocks keep wire order and an index names one
    // block for the whole stream. Splicing ahead of earlier text would strand
    // every index already emitted, and neither host has a reindex event to
    // correct it. Presentation order is the renderer's job.
    this.thinkingBlockIndex = this.blocks.openThinking();
    return this.thinkingBlockIndex;
  }

  private emitThinking(thinking: string): void {
    if (!thinking) return;
    this.blocks.appendThinking(this.ensureThinkingBlock(), thinking);
  }
}
