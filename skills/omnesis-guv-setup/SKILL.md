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
- Never print a token or put it on a command line. Redeem with `--save <path>`
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
   `curl -fsS https://<gateway>:7600/health`. Add `--cacert <ca.pem>` if its
   certificate is not publicly trusted; never `-k` against a remote host.

### 2. Install the handler

```sh
git clone https://github.com/omnesis-dev/omnesis-guv.git && cd omnesis-guv
bun install
bun run sync-sdk
bun test
```

`bun run sync-sdk` copies the SDK that ships with the `guv` on `PATH` into
`.guv-sdk/`, and explains what is missing when it cannot.

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

Without the Omnesis CLI:

```sh
(umask 077; curl -sS --fail-with-body -X POST https://<gateway>:7600/devices/pair \
  -H 'Content-Type: application/json' -d '{"pairingCode":"<code>"}' |
  jq -er .token > ~/.config/omnesis/guv.token)
```

### 4. Prove the integration answers before touching Guv

```sh
gateway=https://<gateway>:7600
token_file=$HOME/.config/omnesis/guv.token
printf 'Authorization: Bearer %s\n' "$(cat "$token_file")" |
  curl -sS --fail-with-body -H @- -X POST "$gateway/answer" \
    -H 'Content-Type: application/json' \
    -d '{"question":"Reply with exactly: Omnesis works","approval":"never"}'
```

`printf` is a shell builtin, so the token reaches curl on stdin, never on its
command line. Expect `"status":"released"`. A 403 with
`ACCESS_LEVEL_REQUIRED` means the integration has no access level yet; a 401
means the token is not valid, so pair again. Do not continue until this
succeeds.

### 5. Configure and load the handler

```sh
cp handler.config.example.json handler.config.json
```

In `handler.config.json`, set `--gateway-url` and `--token-file` (an
absolute path: the command runs without a shell). Add `--ca-file <absolute
path>` for a gateway whose certificate is not publicly trusted. Then, with the
user's approval:

```sh
guv handler load handler.config.json
```

Restart the daemon (`brew services restart guv`, a foreground `guv run`,
or whatever service manager runs it), then check that
`guv status` shows `handler ok`. `guv handler load` alone restarts nothing.

### 6. Confirm from the Guv app

Ask the user to send `Reply with exactly: Guv works` from the Guv app. Done
when the app shows the reply. Every failure also arrives as a readable reply
naming its cause, so a terse error there is itself the diagnosis.
