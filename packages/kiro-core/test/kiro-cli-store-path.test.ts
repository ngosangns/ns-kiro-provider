// ABOUTME: Pins where the kiro-cli credential store is looked for per platform.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKiroCliDbPath } from "../src/kiro-cli.js";

const osMock = vi.hoisted(() => ({ platform: "win32", home: "" }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  platform: () => osMock.platform,
  homedir: () => osMock.home,
}));

let tempDir: string | undefined;
let localAppData = "";
let roamingAppData = "";

/** Write a stand-in store, since only the path — not the schema — is under test. */
function writeStore(storePath: string): string {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, "");
  return storePath;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "kiro-cli-store-"));
  osMock.home = join(tempDir, "home");
  localAppData = join(tempDir, "Local");
  roamingAppData = join(tempDir, "Roaming");
  process.env.LOCALAPPDATA = localAppData;
  process.env.APPDATA = roamingAppData;
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("getKiroCliDbPath", () => {
  it("prefers the 2.x Windows store under LocalAppData over the legacy Roaming one", () => {
    osMock.platform = "win32";
    const current = writeStore(join(localAppData, "Kiro-Cli", "data.sqlite3"));
    writeStore(join(roamingAppData, "kiro-cli", "data.sqlite3"));

    expect(getKiroCliDbPath()).toBe(current);
  });

  it("finds the 2.x Windows store when only it exists", () => {
    osMock.platform = "win32";
    const current = writeStore(join(localAppData, "Kiro-Cli", "data.sqlite3"));

    expect(getKiroCliDbPath()).toBe(current);
  });

  it("reads the legacy Roaming store a pre-2.x CLI left behind", () => {
    osMock.platform = "win32";
    const legacy = writeStore(join(roamingAppData, "kiro-cli", "data.sqlite3"));

    expect(getKiroCliDbPath()).toBe(legacy);
  });

  it("reports no store when neither Windows layout is present", () => {
    osMock.platform = "win32";

    expect(getKiroCliDbPath()).toBeUndefined();
  });

  it("uses each platform's own data directory", () => {
    osMock.platform = "darwin";
    const macStore = writeStore(join(osMock.home, "Library", "Application Support", "kiro-cli", "data.sqlite3"));
    expect(getKiroCliDbPath()).toBe(macStore);

    osMock.platform = "linux";
    const linuxStore = writeStore(join(osMock.home, ".local", "share", "kiro-cli", "data.sqlite3"));
    expect(getKiroCliDbPath()).toBe(linuxStore);
  });
});
