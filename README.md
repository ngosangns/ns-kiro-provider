# ns-kiro-provider

Kiro (AWS CodeWhisperer/Q) as a model provider for two coding agents:
[OMP](https://github.com/can1357/oh-my-pi) and the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The two hosts share no plumbing — OMP registers a provider through its extension
API, the Harness registers an `LlmAdapter` on a Cordis service — but they need
the same thing underneath: Kiro's endpoints, its model catalog, its credentials,
and its streaming wire protocol. That layer lives once, in `ns-kiro-core`, and each
adapter is thin.

```
┌─────────────────────── ns-kiro-core ───────────────────────┐
│  endpoints · model catalog + cache · kiro-cli credentials  │
│ token refresh · AWS event-stream framing · thinking parser │
│ tool-call recovery · history repair · retry classification │
└───────────────┬────────────────────────────┬───────────────┘
                │                            │
      ns-omp-provider-kiro            ns-dsh-llm-kiro
    registerProvider("kiro")   registerAdapter(["kiro"], …)
                │                            │
             omp 18.x                     dsh 0.1.x
```

## Requirements

A Kiro session on the machine. This project establishes no browser flow of its
own — every interactive method Kiro supports already lands a session in the
kiro-cli store or the Kiro IDE token file, and both adapters read and refresh
that session, writing refreshes back so kiro-cli stays on the same token.

```bash
kiro-cli login
```

Builder ID, IAM Identity Center, Google, GitHub, and enterprise OIDC all work,
because kiro-cli does them. A Kiro API key (`ksk_…`) is accepted directly.

## What Kiro reports, and what it does not

Measured 2026-09-06 against `claude-sonnet-5` in `us-east-1`. Recorded here so
the questions are not re-opened from first principles.

**Token counts: none.** Kiro's `usage` frame is a billing record —
`{unit: "credit", usage: 0.0659}` — not token counts. `usage.input` is therefore
derived from the `contextUsagePercentage` frame, and `usage.output` from a
tiktoken estimate over what the model emitted. `usage.credits` carries the
figure Kiro actually bills.

**Prompt caching: real, but not controllable.** Kiro caches prompts server-side
on its own: a repeated prefix billed ~0.035 credits against ~0.066 for a fresh
one, and a changed prefix went straight back to the full price. There is no way
to ask for it — every model's `additionalModelRequestFieldsSchema` sets
`"additionalProperties": false` and allows only `thinking`/`output_config`/
`max_tokens` (Claude) or `reasoning` (GPT), so a `cachePoint` or `cache_control`
field is rejected rather than honoured. Kiro also reports no cache token counts.

Reasoning effort is part of the cache key: changing it misses even when the
prompt is byte-identical, and each effort level then warms its own entry.

Set `KIRO_DEBUG=1` to log the frames verbatim (`~/.ns-kiro-provider/logs/`) if
any of this needs re-checking against a newer Kiro.

## Install

All three packages are published on npm (`ns-kiro-core`, `ns-omp-provider-kiro`,
`ns-dsh-llm-kiro`). Both adapters accept a plain npm package name for their
install command — no clone or build required, see the per-package sections
below. A clone is only needed to develop `ns-kiro-core` itself (not meant for
direct install) or to run an adapter from a local build before it's released:

```bash
git clone git@github.com:ngosangns/ns-kiro-provider.git
cd ns-kiro-provider && pnpm install && pnpm -r build
```

## OMP

```bash
omp plugin install ns-omp-provider-kiro
omp --model kiro/claude-sonnet-4-6
```

`/login kiro` picks up the kiro-cli session, or prompts for an API key when
there is none. `/model` then lists whatever your account's region actually
serves — the catalog is fetched from Kiro rather than hardcoded. See
[the package README](packages/omp-provider-kiro) for version pinning and
installing from a local build.

## DeepSeek Harness

```bash
dsh plugin --profile <profile> add ns-dsh-llm-kiro
```

See [the package README](packages/dsh-llm-kiro) for version pinning and
installing from a local build. Then add the row to that profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: llm-kiro
      name: 'ns-dsh-llm-kiro'
      config:
        provider: kiro

- id: agent-default-model
  config:
    provider: kiro
    model: claude-sonnet-4-6
```

`config.region` pins the Kiro API region; leaving it out derives the region from
the credential, which is what a single-account machine wants.

## Packages

| Package | What it is |
| --- | --- |
| [`ns-kiro-core`](packages/kiro-core) | The Kiro protocol, with no host types in it |
| [`ns-omp-provider-kiro`](packages/omp-provider-kiro) | OMP extension |
| [`ns-dsh-llm-kiro`](packages/dsh-llm-kiro) | DeepSeek Harness Cordis plugin |

## Development

See [DEVELOPER.md](DEVELOPER.md) for building from source, running tests, and
contributing.

## What this is not

Kiro's runtime API is reverse-engineered and has no public specification. AWS
can change the wire format without notice, and using it from a client that is
not Kiro's own sits outside the supported path — check your own agreement before
relying on it.

## Credit

The protocol layer is a port of
[pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro) by Mike
O'Brien (MIT). See [NOTICE](NOTICE) for what was taken and what changed.
