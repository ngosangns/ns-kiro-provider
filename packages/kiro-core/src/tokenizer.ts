// ABOUTME: Token counting using js-tiktoken with lazy-loaded cl100k_base encoding.
// ABOUTME: Provides accurate token counts for Kiro API response content.

import { Tiktoken } from "js-tiktoken/lite";
import cl100kBase from "js-tiktoken/ranks/cl100k_base";

// Deliberately not `encodingForModel` from the package root: that entry point
// embeds every encoding's BPE ranks, which is 5.6 MB in a bundled extension.
// Only cl100k_base is ever used here — it is what `gpt-4` resolves to.
let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) encoder = new Tiktoken(cl100kBase);
  return encoder;
}

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return getEncoder().encode(text).length;
}
