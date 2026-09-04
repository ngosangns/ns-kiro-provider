// ABOUTME: Truncation detection and recovery notice for interrupted Kiro responses.
// ABOUTME: Detects when the previous assistant response was cut off and injects a continuation notice.

import type { KiroMessage } from "./types.js";

export const TRUNCATION_NOTICE =
  "[NOTE: Your previous response was cut off due to length limits. Please continue from where you left off.]";

export function wasPreviousResponseTruncated(messages: KiroMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") return message.stopReason === "length";
  }
  return false;
}
