// ABOUTME: Tests rebuilding the core's model descriptor from what OMP hands back at request time.

import { rmSync, writeFileSync } from "node:fs";
import { KIRO_MANAGEMENT_CACHE_PATH } from "ns-kiro-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `stream.ts` also imports `@oh-my-pi/pi-ai` for its streaming runtime classes
// (`newEventStream`), which this test never exercises. The real package pulls
// in `@oh-my-pi/pi-utils`, whose env loader reads `Bun.env` at module-eval
// time and throws under a non-Bun test runner. Stub it before importing;
// vitest hoists `vi.mock` above the static imports below.
vi.mock("@oh-my-pi/pi-ai", () => ({}));

import { type KiroBackedModel, toKiroModel } from "../src/stream.js";

const TEST_REGION = "us-east-1";

const baseModel: KiroBackedModel = {
  id: "claude-opus-4-5",
  name: "Claude Opus 4.5",
  provider: "kiro",
  api: "kiro-api",
  baseUrl: "https://runtime.us-east-1.kiro.dev/",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
} as unknown as KiroBackedModel;

function writeAuthenticatedCache(models: Array<Record<string, unknown>>): void {
  writeFileSync(
    KIRO_MANAGEMENT_CACHE_PATH,
    JSON.stringify({
      version: 1,
      source: "ns-kiro-provider-management",
      regions: { [TEST_REGION]: { region: TEST_REGION, fetchedAt: Date.now(), models } },
    }),
    "utf-8",
  );
}

beforeEach(() => {
  rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
});

afterEach(() => {
  rmSync(KIRO_MANAGEMENT_CACHE_PATH, { force: true });
});

describe("toKiroModel", () => {
  it("resolves the wire id from the authenticated regional cache for a model absent from the bootstrap list", () => {
    // `claude-opus-4-5`'s bootstrap-list entry (if any) is irrelevant here: the
    // authenticated cache is authoritative once discovery has run, and it is
    // the only place a model discovered exclusively through the live catalog
    // (never in the hardcoded bootstrap) can be found at all.
    writeAuthenticatedCache([
      {
        id: "claude-opus-4-5",
        kiroModelId: "claude-opus-4.5",
        name: "Claude Opus 4.5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ]);

    const resolved = toKiroModel(baseModel, TEST_REGION);
    expect(resolved.kiroModelId).toBe("claude-opus-4.5");
  });

  it("does not fabricate a wire id equal to the dash-spelled local id when the cache has no matching entry", () => {
    // Regression guard: the earlier bug filled `kiroModelId` with `model.id`
    // (`some-unlisted-model`) whenever the catalog lookup missed, and Kiro
    // rejects that spelling with `INVALID_MODEL_ID`. An unresolved model
    // falls back to `""` (falsy) rather than a spelling that looks real, so
    // `resolveKiroModel`'s own fallback chain runs instead of being
    // short-circuited by a value that is really just `model.id` again.
    //
    // A non-empty cache with an unrelated model, not an empty one: an empty
    // `models` array is itself treated as a corrupt cache and discarded,
    // which would fall back to the bootstrap list instead of exercising the
    // "authenticated but unmatched" path this guards.
    writeAuthenticatedCache([
      {
        id: "some-other-model",
        kiroModelId: "some-other-model",
        name: "Some Other Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 8_192,
      },
    ]);
    const unlisted: KiroBackedModel = { ...baseModel, id: "some-unlisted-model" };
    const resolved = toKiroModel(unlisted, TEST_REGION);
    expect(resolved.kiroModelId).toBe("");
  });

  it("carries the request-fields schema from a matched authenticated-catalog entry", () => {
    const schema = { type: "object", properties: { output_config: { type: "object" } } };
    writeAuthenticatedCache([
      {
        id: "claude-opus-4-5",
        kiroModelId: "claude-opus-4.5",
        name: "Claude Opus 4.5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
        additionalModelRequestFieldsSchema: schema,
      },
    ]);

    const resolved = toKiroModel(baseModel, TEST_REGION);
    expect(resolved.additionalModelRequestFieldsSchema).toEqual(schema);
  });
});
