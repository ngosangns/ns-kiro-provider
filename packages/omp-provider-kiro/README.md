# omp-provider-kiro

Kiro (AWS CodeWhisperer/Q) models in [OMP](https://github.com/can1357/oh-my-pi).

```bash
omp plugin install omp-provider-kiro
```

Sign in once with kiro-cli — Builder ID, IAM Identity Center, Google, GitHub, or
enterprise OIDC all work, because kiro-cli does them:

```bash
kiro-cli login
```

Then, in OMP:

```
/login kiro
/model
```

`/login kiro` picks up the kiro-cli session and refreshes it when it expires,
writing the refresh back so both tools stay on the same token. With no session
on the machine it prompts for a Kiro API key (`ksk_…`) instead.

`/model` lists whatever your account's region actually serves: the catalog is
fetched from Kiro's management API and cached for an hour, so a model added
upstream shows up without a release here.

## Notes

- Reasoning effort maps onto Kiro's own ladder per model — `xhigh` and `max`
  exist only where the model advertises them, and a request for more thinking
  than a model offers is clamped rather than rejected.
- Usage (`/settings`) reports the account's Kiro credit balance.
- `KIRO_API_KEY` is read as a fallback when no session is stored.
- `KIRO_DEBUG=1` writes a full request/response trace to
  `~/.kiro-providers/logs/kiro-debug.log`, with credentials redacted.

Part of [kiro-providers](https://github.com/ngosangns/kiro-providers).
