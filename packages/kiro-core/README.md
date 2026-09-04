# ns-kiro-core

The Kiro (AWS CodeWhisperer/Q) protocol, with no host types in it.

This package is the shared half of
[ns-kiro-provider](https://github.com/ngosangns/ns-kiro-provider): everything a
Kiro client needs that is not specific to one coding agent.

Published on npm as `ns-kiro-core`. Pulled in as a dependency by the two
adapters below — not meant to be installed on its own.

- **Endpoints** — SSO region to management/runtime host resolution.
- **Model catalog** — the bootstrap list, the authenticated regional catalog,
  and a validated on-disk cache at `~/.ns-kiro-provider-models-cache.json`.
- **Credentials** — reads the kiro-cli SQLite store and the Kiro IDE token file,
  refreshes IDC / desktop / external-IdP / API-key sessions, and writes
  refreshes back so kiro-cli stays on the same token.
- **Streaming** — AWS event-stream framing, thinking-tag parsing, native and
  text-dialect tool-call recovery, history validation and repair, and the whole
  retry ladder (transport timeouts, capacity pressure, request-rate windows, 403
  credential rotation, degenerate 200s).

## The neutral seam

`streamKiro` takes a request built from this package's own vocabulary and yields
its own events:

```ts
import { streamKiro, resolveKiroCredentials, getCachedModels } from "ns-kiro-core";

const credentials = await resolveKiroCredentials();
const model = getCachedModels("us-east-1").find((m) => m.id === "claude-sonnet-4-6");

for await (const event of streamKiro({
  model: { ...model, region: "us-east-1" },
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  accessToken: credentials.access,
  effort: "medium",
})) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}
```

An adapter owes two translations — host messages in, host stream events out —
and nothing else. Block indexes are monotonic across the whole response,
including across an internal retry, so a host that cannot un-deliver a block
still receives a coherent sequence; `canDiscardEmittedBlocks` tells the core
which kind of host it is talking to.

## Credit

Ported from [pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro)
by Mike O'Brien (MIT). The port replaces pi-ai's message and event types with
the neutral vocabulary above; the protocol behaviour is upstream's.
