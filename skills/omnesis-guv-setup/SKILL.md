---
name: omnesis-guv-setup
description: Set up the Omnesis Guv handler and pair it to an Omnesis gateway.
---

# Omnesis Guv setup

Use this skill when the user asks to connect Guv to Omnesis — install the
`omnesis-guv` handler, pair a dedicated device to their gateway, and switch
the Guv daemon onto it. Do not use it for Guv's own Familiar pairing or for
Claude/Pi handler problems; those stay with `guv setup` / `guv doctor` and
https://guv.sh/docs#troubleshooting.

## Safety

- Use Guv CLI commands to examine or change Guv configuration.
- Do not read or edit the Guv credential file directly.
- Never print a token, pairing code, or raw credential. When redeeming,
  always pass `--save <path>` so the token lands in a 0600 file instead of
  terminal output.
- Install only handler code the user trusts. Handlers run on the user's
  machine with the user's credentials.
- Get user approval before replacing the selected handler. (`guv handler
  load` + daemon restart.)

## Prerequisites

1. Guv installed and its Familiar pairing healthy: `guv status` must show
   `api ok` and `auth ok`. If auth fails, stop here and run `guv setup`
   first — no handler can receive Jobs without it.
2. Bun available (`bun --version`). The handler runs on Bun.
3. The Omnesis gateway reachable from the Guv machine and serving `/answer`.
   Confirm with `curl -k https://<gateway-host>:7600/health` (expect
   `"status":"ok"`). Same-machine default: `https://localhost:7600`.
4. This repo checked out on the Guv machine (the handler runs from it).

## Procedure

### 1. Install the handler dependencies

```sh
cd <omnesis-guv-checkout>
bun install
# Attach the Guv handler SDK matching the installed Guv release.
# Homebrew/Linuxbrew:
bun add "@familiar/guv-handler-sdk@file:$(brew --prefix guv)/share/guv/sdk"
# Direct archive:
bun add "@familiar/guv-handler-sdk@file:$HOME/.local/share/guv/sdk"
```

The SDK is never committed; it stays a local install step.

### 2. Pair a dedicated device (on the gateway machine)

The handler must NOT use `--kind agent`: the gateway locks that kind to the
`subscriptions:receive` scope and rejects anything else. Pair a least-privilege
client device carrying only the `answer` scope:

```sh
omnesis devices pair --kind cli --scopes answer
```

This prints a short-lived pairing code plus the granted scopes. Verify the
scopes line reads `answer` before continuing.

### 3. Redeem on the Guv machine (token goes straight to a file)

```sh
omnesis devices redeem <code> --gateway-url https://<gateway-host>:7600 --save ~/.config/omnesis/guv-handler.token
chmod 600 ~/.config/omnesis/guv-handler.token
```

If the `omnesis` CLI is not installed on the Guv machine, redeem via
`POST /devices/pair` with the code and write the returned token to the same
path with mode 0600.

### 4. Configure the daemon environment

The handler reads (see `src/config.ts`):

- `OMNESIS_GATEWAY_URL` — default `https://localhost:7600`. Set it when the
  gateway is remote.
- `OMNESIS_TOKEN_FILE` — path to the file from step 3 (preferred), or
  `OMNESIS_TOKEN` for a literal token. Never commit either.
- `OMNESIS_ANSWER_TIMEOUT_MS` — per-question budget, default 240000. Must
  fit inside the handler `timeout_ms`.
- `OMNESIS_INSECURE_TLS=1` — only for loopback gateways with self-signed
  certificates. Never across a network.

Export these in whatever supervises the daemon (systemd unit
`EnvironmentFile`, `guv run` shell, etc.) so the handler inherits them.

### 5. Prove Omnesis answers before touching Guv

```sh
export OMNESIS_GATEWAY_URL=https://<gateway-host>:7600
export OMNESIS_TOKEN_FILE=~/.config/omnesis/guv-handler.token
[ "${OMNESIS_GATEWAY_URL#https://localhost}" != "$OMNESIS_GATEWAY_URL" ] && export OMNESIS_INSECURE_TLS=1
bun -e 'import {AnswerClient} from "./src/answer-client.ts"; import {readFileSync} from "node:fs";
const c = new AnswerClient({baseUrl: process.env.OMNESIS_GATEWAY_URL!, token: readFileSync(process.env.OMNESIS_TOKEN_FILE!, "utf8").trim()});
console.log(JSON.stringify(await c.submit({question: "Reply with exactly: agent works", clientRequestId: `guv_smoke_${Date.now()}`}), null, 2));'
```

Expect `"status": "released"` (or `released_with_reductions`). A 401/403
means the token or scope is wrong — re-pair, do not proceed. A 404 means the
gateway does not serve `/answer` at that URL.

### 6. Load the handler and restart the daemon

```sh
umask 077
HANDLER_CONFIG="$(mktemp "$PWD/.guv-handler.XXXXXX")"
cat > "$HANDLER_CONFIG" <<EOF
{
  "command": ["bun", "src/handler.ts"],
  "cwd": "$PWD",
  "timeout_ms": 300000,
  "max_concurrency": 4
}
EOF
guv handler load "$HANDLER_CONFIG"
rm -f "$HANDLER_CONFIG"
# restart the daemon (service manager or foreground `guv run`), then:
guv status
```

`guv status` must show `handler ok`. If it shows `handler NOT RUNNING`,
the daemon did not pick up the new config — restart it again; `guv handler
load` alone never restarts anything.

### 7. Confirm recovery

1. `guv status`: all required checks pass.
2. Ask the user to send `Reply with exactly: Guv works` from the Guv app.
3. Done only when the app shows `Done` and displays a reply whose content
   came from Omnesis (every failure is returned as visible text explaining
   the cause, so a terse error there is itself the diagnosis).

`Working` means the Job status is `running`. A notification does not prove
successful Job completion.
