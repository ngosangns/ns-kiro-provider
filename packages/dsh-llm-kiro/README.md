# ns-dsh-llm-kiro

Kiro (AWS CodeWhisperer/Q) as a provider route in the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Kiro speaks its own streaming protocol — AWS event-stream framing over
`generateAssistantResponse` — which no configurable route can describe, so this
registers a real `LlmAdapter` rather than a profile on a generic one.

## Install

Published on npm as `ns-dsh-llm-kiro`:

```bash
kiro-cli login
dsh plugin --profile <profile> add ns-dsh-llm-kiro
```

Pin a version with `add ns-dsh-llm-kiro@0.2.0` — `dsh plugin add` forwards
straight to `pnpm add`, which resolves bare names and `name@version` from the
registry same as any other package.

### From a local build

To point the profile at a local build instead — for developing this package or
`ns-kiro-core` before a release:

```bash
kiro-cli login
pnpm install && pnpm -r build
dsh plugin --profile <profile> add link:$PWD/packages/dsh-llm-kiro
```

`link:` points the profile at the local build from `pnpm -r build` rather than
the registry tarball.

Add the row to that profile's `cordis.patch.yml`:

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

Verify the composition, then run:

```bash
dsh --profile <profile> --dump-config | grep -A3 llm-kiro
dsh --profile <profile> "what changed in this repo?"
```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `kiro` | Provider route the adapter registers under |
| `displayName` | `Kiro` | Name shown in model selectors |
| `region` | derived | Kiro API region; derived from the credential when absent |

## Notes

- Sessions come from the machine. The adapter reads the kiro-cli store or the
  Kiro IDE token file, refreshes on expiry, and writes the refresh back. It runs
  no browser flow of its own.
- Images are sent when the deployment mounts the `attachments` service, and
  dropped otherwise — the plugin does not require that service, so a text-only
  profile still boots.
- Kiro's failure vocabulary is mapped onto the Harness routing codes
  (`AUTH`, `RATE_LIMIT`, `OVERLOADED`, `QUOTA_EXCEEDED`, `CONTEXT_OVERFLOW`,
  `TIMEOUT`), so the loop's retry policy sees a classified failure rather than
  provider prose.
- A degenerate response is retried inside the adapter only while nothing has
  been delivered: the Harness assembler cannot un-deliver a block, so a response
  already streamed out is settled rather than replayed.

Part of [ns-kiro-provider](https://github.com/ngosangns/ns-kiro-provider).
