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
