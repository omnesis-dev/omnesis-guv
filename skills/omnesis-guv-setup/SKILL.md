---
name: omnesis-guv-setup
description: Connect Guv to an Omnesis gateway with the omnesis-guv handler, paired as an Omnesis integration.
---

# Omnesis Guv setup

Use this skill when the user asks to connect Guv to Omnesis: install the
`omnesis-guv` handler, pair it with their gateway as an integration, and switch
the Guv daemon onto it. Guv's own pairing (`auth FAILED` in `guv status`) is
not part of it; that is `guv setup`, which the user may have to finish on
their phone.

## Rules

- Change Guv's configuration only through the `guv` CLI. Never read or edit
  Guv's credential file.
- Never print a token or a pairing code in full. Redeem with `--save <path>`
  so the token goes straight into a mode-0600 file.
- The access level is the user's decision: it sets which sources answers may
  draw on and whether a privacy policy reviews them. Ask which level to use (or
  whether to create one) instead of choosing for them.
- Get the user's approval before replacing the selected Guv handler.

## Procedure

### 1. Check the prerequisites

1. `guv status` shows `api ok` and `auth ok`. If auth fails, stop: no handler
   receives Jobs until the user reruns `guv setup`.
2. `bun --version` works.
3. The gateway answers from the Guv machine:
   `curl -fsS https://<gateway>:7600/health`. Use `--cacert <ca.pem>` if its
   certificate is not publicly trusted; never `-k` against a remote host.

### 2. Install the handler

```sh
git clone https://github.com/omnesis-dev/omnesis-guv.git && cd omnesis-guv
bun install
bun run sync-sdk
bun test
```

`bun run sync-sdk` copies the SDK shipped with the installed Guv into
`.guv-sdk/`; it fails with an explanation if Guv or a matching `zod` is
missing.

### 3. Pair the integration

Preferred: the user pairs it from the portal (**Settings → Devices → Pair
device → Integration**), names it (for example `Guv`), chooses its access
level, and gives you the code.

Alternatively, on the gateway machine:

```sh
omnesis devices pair --kind integration --name Guv
```

That code carries no access level; after redeeming, the user chooses one on
the integration's card on the Devices page. Until then its questions are
refused.

Redeem on the Guv machine:

```sh
omnesis devices redeem <code> --gateway-url https://<gateway>:7600 --save ~/.config/omnesis/guv.token
```

Without the Omnesis CLI, `POST /devices/pair` with
`{"pairingCode":"<code>","kind":"integration"}` and write the response's
`token` field to the same path with mode 0600.

### 4. Configure the daemon's environment

Set, wherever the Guv daemon's environment comes from (for a systemd user
service, a drop-in from `systemctl --user edit guv.service`):

- `OMNESIS_GATEWAY_URL` — the gateway address.
- `OMNESIS_TOKEN_FILE` — the absolute path of the token file.
- `OMNESIS_CA_FILE` — only for a gateway whose certificate is not publicly
  trusted: an absolute path to its CA bundle.
- `OMNESIS_ANSWER_TIMEOUT_MS` — only to change the default 240000; keep it
  under the handler's `timeout_ms` (300000).

### 5. Prove the integration answers before touching Guv

```sh
curl -fsS -X POST "$OMNESIS_GATEWAY_URL/answer" \
  -H "Authorization: Bearer $(cat "$OMNESIS_TOKEN_FILE")" \
  -H 'Content-Type: application/json' \
  -d '{"question":"Reply with exactly: Omnesis works","approval":"never"}'
```

Expect `"status":"released"`. A 403 with `ACCESS_LEVEL_REQUIRED` means the
integration has no access level yet; a 401 means the token is not valid —
re-pair. Do not continue until this succeeds.

### 6. Load the handler and restart Guv

With the user's approval, from the checkout:

```sh
guv handler load handler.config.example.json
```

Restart the daemon (`systemctl --user restart guv.service`,
`brew services restart guv`, or a foreground `guv run`), then check that
`guv status` shows `handler ok`. `guv handler load` alone restarts nothing.

### 7. Confirm from the Guv app

Ask the user to send `Reply with exactly: Guv works` from the Guv app. Done
when the app shows the reply. Every failure also arrives as a readable reply
naming its cause, so a terse error there is itself the diagnosis.
