// ABOUTME: Guards the published shape and the cordis plugin contract dsh loads by.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as plugin from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as Record<string, never>;

describe("packaging", () => {
  it("exports the cordis plugin surface dsh's loader activates by", () => {
    expect(plugin.name).toBe("llm-kiro");
    expect(typeof plugin.apply).toBe("function");
    expect(plugin.Config).toBeDefined();
  });

  it("injects only the service every deployment mounts", () => {
    // `attachments` is deliberately absent: a text-only deployment never mounts
    // it, and a required inject would leave the whole plugin pending at boot.
    expect(plugin.inject).toEqual(["llm"]);
  });

  it("defaults the route to kiro", () => {
    expect(plugin.Config({} as never).provider).toBe("kiro");
  });

  it("keeps every harness package out of the runtime dependency set", () => {
    const dependencies = Object.keys((manifest.dependencies as unknown as object) ?? {});
    expect(dependencies.filter((name) => name.startsWith("@deepseek-ai/dsh-"))).toEqual([]);
    expect(Object.keys((manifest.peerDependencies as unknown as object) ?? {})).toContain("@deepseek-ai/dsh-llm");
  });

  it("publishes dist rather than src", () => {
    expect(manifest.files).toContain("dist");
    expect(manifest.main).toBe("./dist/index.js");
  });
});
