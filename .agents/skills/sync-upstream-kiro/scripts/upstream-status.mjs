#!/usr/bin/env node
// ABOUTME: Chấm điểm khoảng cách giữa repo này và upstream pi-provider-kiro.
// ABOUTME: Chỉ đọc — fetch, phân loại commit theo file nó chạm, không sửa gì.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

const statePath = resolve(repoRoot, ".upstream-sync.json");
if (!existsSync(statePath)) {
  console.error("Không tìm thấy .upstream-sync.json — chạy skill sync-upstream-kiro bước 0 trước.");
  process.exit(1);
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
const { remote = "upstream", branch = "main" } = state.upstream ?? {};
const ref = `${remote}/${branch}`;

// --- bước 0: remote phải tồn tại và fetch-only ---------------------------------
try {
  git("remote", "get-url", remote);
} catch {
  console.error(`Chưa có remote '${remote}'. Xem bước 0 của SKILL.md.`);
  process.exit(1);
}
try {
  git("config", "remote." + remote + ".tagOpt", "--no-tags");
  git("fetch", remote);
} catch (err) {
  console.error(`fetch ${remote} thất bại: ${err.message}`);
  process.exit(1);
}

const tip = git("rev-parse", ref);
const base = process.argv[2] ?? state.syncedCommit; // arg 1 = baseline thay thế, để dry-run

const pinned = base === state.syncedCommit;
console.log(
  pinned
    ? `baseline : ${base.slice(0, 9)}  ${state.syncedTag ?? ""}  (${state.syncedAt ?? "?"})`
    : `baseline : ${base.slice(0, 9)}  [override từ argv — không phải baseline đã ghi]`,
);
console.log(`upstream : ${tip.slice(0, 9)}  ${ref}`);

if (base === tip) {
  console.log("\nĐã ngang bằng upstream. Không có gì để port.");
  process.exit(0);
}

// --- phân loại ------------------------------------------------------------------
const notPorted = new Set((state.notPorted ?? []).map((e) => e.path));
const notPortedGlobs = [...notPorted].filter((p) => p.includes("*")).map((p) => p.replace(/\*+/g, ""));
const mapping = state.pathMapping ?? {};

const isNotPorted = (p) => notPorted.has(p) || notPortedGlobs.some((g) => p.startsWith(g));

/** File upstream có phụ thuộc type của pi hay không — quyết định độ nặng của việc port. */
const piCoupled = (path) => {
  try {
    const src = git("show", `${ref}:${path}`);
    return /@earendil-works\/pi-|@oh-my-pi\/pi-/.test(src);
  } catch {
    return false; // file đã bị xóa ở tip
  }
};

const localTarget = (path) => {
  if (mapping[path]) return mapping[path];
  const m = path.match(/^test\/(.+)$/);
  if (m) return `packages/kiro-core/test/${m[1]}`;
  return null;
};

const commits = git("log", "--reverse", "--format=%H%x00%s", `${base}..${tip}`)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [sha, subject] = line.split("\0");
    const files = git("show", "--pretty=", "--name-only", sha).split("\n").filter(Boolean);
    return { sha, subject, files };
  });

const noise = (c) =>
  /^chore\(release\)/.test(c.subject) ||
  /^Merge pull request .* from .*release-/.test(c.subject) ||
  c.files.every((f) => isNotPorted(f) || !/^(src|test)\//.test(f));

const actionable = commits.filter((c) => !noise(c));
console.log(`\n${commits.length} commit mới, ${commits.length - actionable.length} là nhiễu (release/ngoài phạm vi).`);

if (actionable.length === 0) {
  console.log("Không có commit nào cần port. Cập nhật syncedCommit sang tip là xong.");
  process.exit(0);
}

const missingLocal = new Set();
console.log(`\n${actionable.length} commit cần đánh giá:\n`);
for (const c of actionable) {
  console.log(`  ${c.sha.slice(0, 9)}  ${c.subject}`);
  for (const f of c.files) {
    if (!/^(src|test)\//.test(f)) continue;
    if (isNotPorted(f)) {
      console.log(`      SKIP      ${f}`);
      continue;
    }
    const target = localTarget(f);
    if (!target) {
      console.log(`      MỚI       ${f}  (chưa có trong pathMapping — quyết định rồi ghi vào .upstream-sync.json)`);
      continue;
    }
    const exists = existsSync(resolve(repoRoot, target));
    if (!exists) missingLocal.add(`${f} -> ${target}`);
    const weight = piCoupled(f) ? "PI-COUPLED" : "neutral   ";
    console.log(`      ${weight} ${f}  ->  ${target}${exists ? "" : "  [KHÔNG TỒN TẠI]"}`);
  }
  console.log();
}

if (missingLocal.size > 0) {
  console.log("Không có file đích tương ứng — phải quyết định port hay bỏ, và ghi lý do vào .upstream-sync.json:");
  for (const m of missingLocal) console.log(`  - ${m}`);
  console.log();
}

console.log("PI-COUPLED = phải dịch vocabulary sang packages/kiro-core/src/types.ts, xem bảng ở SKILL.md.");
console.log(`Ngữ cảnh PR: gh pr list --repo mikeyobrien/pi-provider-kiro --state merged --limit 20`);
console.log(`Trình bảng triage cho user và chờ duyệt trước khi sửa code.`);
