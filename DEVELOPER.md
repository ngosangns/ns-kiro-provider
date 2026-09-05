# Developing ns-kiro-provider

Contributor guide for building, testing, and extending this repo. For what
the project is and how to install/use it, see [README.md](README.md).

## Layout

pnpm workspace, three packages under `packages/`:

| Package | What it is |
| --- | --- |
| [`ns-kiro-core`](packages/kiro-core) | The Kiro (AWS CodeWhisperer/Q) protocol, with no host types in it — endpoints, model catalog + cache, kiro-cli/IDE credential handling and refresh, AWS event-stream framing, thinking-tag parsing, tool-call recovery, history repair, retry classification |
| [`ns-omp-provider-kiro`](packages/omp-provider-kiro) | Thin OMP extension: registers Kiro as a provider through OMP's extension API |
| [`ns-dsh-llm-kiro`](packages/dsh-llm-kiro) | Thin DeepSeek Harness Cordis plugin: registers Kiro as an `LlmAdapter` |

`ns-kiro-core` holds all the protocol logic. The two adapters only translate
between their host's types and `ns-kiro-core`'s neutral vocabulary (host messages
in, host stream events out) — see the root README's architecture diagram for
the shared-plumbing rationale. A new host adapter belongs alongside
`ns-omp-provider-kiro`/`ns-dsh-llm-kiro` and should stay a thin translation layer;
protocol changes (streaming, retries, credentials, model catalog) belong in
`ns-kiro-core`.

### One model call, end to end

A single request is split across four modules so each can be read — and
tested — on its own. `stream.ts` is the orchestrator and holds only what needs
the whole picture: credential rotation, the HTTP retry policy, and the decision
to ask again.

| Module | Owns |
| --- | --- |
| [`request-builder.ts`](packages/kiro-core/src/request-builder.ts) | Neutral messages to a `KiroRequest`: history shaping, tool specs, pre-send repair. Pure — no I/O, so request shaping is testable without a transport |
| [`transport.ts`](packages/kiro-core/src/transport.ts) | Abortable delays, the response-header deadline, capacity logging |
| [`response-stream.ts`](packages/kiro-core/src/response-stream.ts) | AWS event-stream framing and the stall timeouts; yields parsed wire events |
| [`response-assembler.ts`](packages/kiro-core/src/response-assembler.ts) | What the response *says*: content blocks, thinking, tool calls, text-dialect recovery, usage, stop reason |
| [`stream.ts`](packages/kiro-core/src/stream.ts) | Orchestration: endpoint and profile resolution, HTTP retries (403 / capacity / rate limit), degenerate-response retries |

When porting an upstream change to `src/stream.ts`, map it to the module that
owns that concern rather than looking for the matching lines — see the
divergence entry in `.upstream-sync.json` for the region map.

## Prerequisites

- Node >=22 (`engines.node` in `package.json`)
- pnpm 11.23.0 (`packageManager` in `package.json`)

## Setup

```bash
git clone git@github.com:ngosangns/ns-kiro-provider.git
cd ns-kiro-provider
pnpm install
```

## Build

```bash
pnpm -r build
```

## Type-check

```bash
pnpm -r check
```

`check` typechecks against built declarations, so it needs a build first —
run `pnpm -r build` before it (CI does the same).

## Test

```bash
pnpm test
```

Runs `vitest run` (see `vitest.config.ts` at the repo root) across the
workspace.

## Lint / format

Biome-based:

```bash
pnpm lint       # biome check .
pnpm lint:fix   # biome check --write .
pnpm format     # biome format --write .
```

## CI

`.github/workflows/ci.yml` runs on push to `main` and on pull requests:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm -r build
pnpm -r check
pnpm test
```

Run the same sequence locally before pushing.

## Releasing

Publishing runs from `.github/workflows/publish.yml` using npm **trusted
publishing**: npm verifies the workflow's OIDC identity instead of a token, so
nothing is stored on a developer machine and no 2FA prompt blocks the release.
Packages are published with provenance.

### One-time setup (per package, on npmjs.com)

For each of `ns-kiro-core`, `ns-omp-provider-kiro` and `ns-dsh-llm-kiro`:
Settings → Trusted Publisher → GitHub Actions, with

| Field | Value |
| --- | --- |
| Organization / user | `ngosangns` |
| Repository | `ns-kiro-provider` |
| Workflow filename | `publish.yml` |
| Environment | *(leave empty)* |

The workflow filename is part of what npm trusts, so renaming the workflow
breaks publishing until the trusted publisher is updated to match.

### Cutting a release

1. Bump `version` in all three `packages/*/package.json` — keep them in step, the
   adapters depend on an exact `ns-kiro-core` version.
2. Merge that to `main`.
3. Tag and push:

   ```bash
   git tag v0.2.2 && git push origin v0.2.2
   ```

The workflow re-runs lint, build, typecheck and tests, refuses to continue if
the tag disagrees with any `package.json`, then packs and publishes
`ns-kiro-core` first — the adapters pin an exact version of it, so the reverse
order would leave them briefly uninstallable.

`workflow_dispatch` runs the same job with a `dry-run` input for checking the
packed output without publishing.

### Why `pnpm pack` and `npm publish`, not one tool

The adapters declare `"ns-kiro-core": "workspace:*"`. Only pnpm rewrites that to
the real version when packing; `npm pack` would ship the literal `workspace:*`
and the published package would be uninstallable. But `pnpm publish` has no
`--provenance` and does not speak OIDC, so the tarball pnpm produces is handed
to `npm publish`. The workflow asserts the dependency was rewritten before it
publishes anything.
