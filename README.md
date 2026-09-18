# omnesis-guv

A [Guv](https://guv.sh) handler that answers every Job through the Omnesis
`/answer` API. Talk to Guv from the app (or a ring that routes to Guv) and
Omnesis — your indexed corpus — produces the reply.

Every outcome, including failures, is returned as user-visible text: an
expired token or a down gateway shows up in the app as an explanation of
what happened and how to re-pair the device, never as a silent failure.

## Layout

- `src/handler.ts` — the Guv handler (`serveHandler` wiring).
- `src/answer-client.ts` — minimal typed HTTPS client for `POST /answer` +
  `GET /answer/tasks/:id`. Vendored (no monorepo dependency) because
  `@omnesis/gateway-client` is not on a package registry; it mirrors that
  client's contract.
- `src/config.ts` — env-based config, token resolved lazily per Job.
- `src/outcome.ts` — gateway four-state response → Guv summary text.
- `skills/omnesis-guv-setup/SKILL.md` — Claude Code skill: point an agent at
  it and it performs the whole setup + pairing below.
- `handler.config.example.json` — template for `guv handler load`.

## Setup

Prerequisites: Guv installed with healthy Familiar pairing (`guv status`
shows `api ok`, `auth ok`), Bun, and a reachable Omnesis gateway serving
`/answer`.

```sh
bun install
# Attach the Guv handler SDK matching the installed Guv release:
bun add "@familiar/guv-handler-sdk@file:$(brew --prefix guv)/share/guv/sdk"
# ...or for direct-archive installs:
bun add "@familiar/guv-handler-sdk@file:$HOME/.local/share/guv/sdk"
```

Pair a dedicated least-privilege device (on the gateway machine — note this
is `--kind cli`, not `--kind agent`, which the gateway locks to the
subscription scope):

```sh
omnesis devices pair --kind cli --scopes answer
omnesis devices redeem <code> --gateway-url https://<gateway-host>:7600 \
  --save ~/.config/omnesis/guv-handler.token
```

Configure the daemon environment (`src/config.ts` documents all knobs):

```sh
export OMNESIS_GATEWAY_URL=https://<gateway-host>:7600
export OMNESIS_TOKEN_FILE=~/.config/omnesis/guv-handler.token
# Loopback + self-signed cert only:
export OMNESIS_INSECURE_TLS=1
```

Smoke-test Omnesis directly (step 5 of the skill), then install:

```sh
# set "cwd" to this checkout, then:
guv handler load <config>
# restart the daemon, then:
guv status   # must show: handler ok
```

Or hand the whole procedure to an agent via
`skills/omnesis-guv-setup/SKILL.md`.

## Troubleshooting

- `Cannot find package 'zod'` at handler startup: Bun resolves the
  file:-installed SDK by real path, outside this checkout. Keep `zod`
  (pinned in `package.json`) installed here and launch with
  `NODE_PATH=<checkout>/node_modules` — the systemd unit in the setup
  skill does this.
- `guv status` shows `handler ok` but the app reports failures: every
  handler-side failure is returned as visible text naming the cause, so
  read the reply — a 401/403 reply walks through re-pairing.
- `auth FAILED ... 401`: the Familiar pairing, independent of Omnesis.
  Run `guv setup` (may need the phone app) before any Job can arrive.

## Tests

```sh
bun test
```

Pure modules only (`answer-client`, `outcome`); no live gateway, no model
inference. The handler entrypoint needs the Guv SDK installed (see above)
but is intentionally thin.

## License

MIT — see `LICENSE`.
