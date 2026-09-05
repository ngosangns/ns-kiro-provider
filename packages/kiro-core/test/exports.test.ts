// ABOUTME: Guards the package's public surface against accidental omissions.
// ABOUTME: 0.2.0 shipped the split modules in dist but forgot to re-export them.

import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * Entry points a consumer is expected to reach for. Not the whole surface —
 * this is a floor, so adding an export never requires touching this list.
 *
 * The four stage entry points earn their place here: `0.2.0` split `streamKiro`
 * into them, shipped the compiled files, and never re-exported them, so
 * `import { buildKiroRequest } from "ns-kiro-core"` failed against the
 * published package while every local test kept passing on deep imports.
 */
const REQUIRED_EXPORTS = [
  // The one call most consumers need.
  "streamKiro",
  // The stages it runs, usable on their own.
  "buildKiroRequest",
  "KiroResponseAssembler",
  "readKiroEventStream",
  "abortableDelay",
  "createResponseHeaderDeadline",
  "logCapacityEvent",
  // Credentials, catalog, usage.
  "resolveKiroCredentials",
  "refreshKiroToken",
  "getCachedModels",
  "updateKiroModelsCache",
  "getKiroCliModelRates",
  "fetchKiroUsage",
  // Wire-level helpers hosts and tools reuse.
  "parseKiroEvent",
  "calculateKiroCost",
  "countTokens",
  "KiroBlockBuffer",
] as const;

describe("public exports", () => {
  it.each(REQUIRED_EXPORTS)("exports %s", (name) => {
    expect(core).toHaveProperty(name);
    expect((core as Record<string, unknown>)[name]).toBeDefined();
  });

  it("exports every module split out of streamKiro", () => {
    // Named separately from the list above so the failure says what was lost.
    const stages = {
      "request-builder": core.buildKiroRequest,
      "response-assembler": core.KiroResponseAssembler,
      "response-stream": core.readKiroEventStream,
      transport: core.abortableDelay,
    };
    for (const [module, entry] of Object.entries(stages)) {
      expect(typeof entry, `${module} entry point`).toBe("function");
    }
  });
});
