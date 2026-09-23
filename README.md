# omnesis-guv

A [Guv](https://guv.sh) handler that answers every Job with
[Omnesis](https://omnesis.dev): talk to Guv, and Omnesis answers from your
indexed data through its `/answer` API.

The handler connects to your gateway as an Omnesis **integration**: a device
that can only ask questions. What its answers may draw on — which sources, and
whether a privacy policy reviews them before they leave the gateway — is the
access level you choose for it in the Omnesis portal, and you can change it
there at any time without touching this handler.

Every Job ends in text you can read in the Guv app. When there is no answer,
the reply says why and what to do: a revoked token, an integration without an
access level, a gateway that is down, an answer the privacy policy withheld.

## Requirements

- Guv, with its own pairing healthy: `guv status` shows `api ok` and `auth ok`.
- [Bun](https://bun.sh).
- An Omnesis gateway that supports integrations, reachable from the Guv machine.

## Install

```sh
git clone https://github.com/omnesis-dev/omnesis-guv.git
cd omnesis-guv
bun install
bun run sync-sdk
```

`bun run sync-sdk` copies the handler SDK that ships with your Guv into
`.guv-sdk/` (it is not published to a registry). Run it again whenever you
upgrade Guv: the SDK must match the daemon.

## Pair the integration

Pairing from the portal chooses the access level in the same step. On the
portal's **Settings → Devices** page, choose **Pair device**, then:

1. **Kind:** Integration.
2. **Name:** what it is, for example `Guv`.
3. **Access level:** the level whose Answer permission Guv's questions use. It
   decides which sources answers may draw on and whether they are reviewed
   under a privacy policy. Create or edit levels on **Settings → Access**.

You can also mint the code from the gateway machine with
`omnesis devices pair --kind integration --name Guv`; the integration then has
no access level, and its questions are refused until you choose one on its
card on the Devices page.

Redeem the code on the Guv machine, saving the token to a file only you can
read:

```sh
omnesis devices redeem <code> --gateway-url https://<gateway>:7600 \
  --save ~/.config/omnesis/guv.token
```

Without the Omnesis CLI there, redeem with `curl` and keep the `token` field
of the response in a mode-0600 file:

```sh
curl -X POST https://<gateway>:7600/devices/pair \
  -H 'Content-Type: application/json' \
  -d '{"pairingCode":"<code>","kind":"integration"}'
```

The token carries only the `answer` scope. The gateway refuses to give an
integration anything more, whatever it asks for.

## Configure

The handler reads its configuration from the environment Guv runs it in:

| Variable                    | Meaning                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `OMNESIS_GATEWAY_URL`       | Required. The gateway address, for example `https://gateway.example.org:7600`. Plain `http` is accepted only for `localhost`.            |
| `OMNESIS_TOKEN_FILE`        | Required. Absolute path of the token file. It is read for every Job, so replacing it rotates the token without restarting Guv.           |
| `OMNESIS_CA_FILE`           | Absolute path of a PEM bundle to trust, for a gateway whose certificate is not publicly trusted (the gateway's own CA, for example).      |
| `OMNESIS_ANSWER_TIMEOUT_MS` | How long one Job may take, retries included. Default `240000`. Keep it under the handler's `timeout_ms`, or Guv restarts the handler. |

A configuration problem does not stop the handler: every Job replies with what
is wrong until you fix it and restart Guv.

With Guv under systemd, set these on the Guv service, for example in a
drop-in created with `systemctl --user edit guv.service`:

```ini
[Service]
Environment=OMNESIS_GATEWAY_URL=https://gateway.example.org:7600
Environment=OMNESIS_TOKEN_FILE=%h/.config/omnesis/guv.token
```

## Load it into Guv

From this checkout, load the handler and restart the daemon:

```sh
guv handler load handler.config.example.json
# restart Guv (systemctl --user restart guv.service, brew services restart guv, or guv run), then:
guv status   # handler ok
```

Guv resolves the file's relative `cwd` against the file itself, so the handler
runs from this checkout. `bun` must be on the `PATH` Guv loads it with.
`handler.config.example.json` gives each Job 300 seconds (`timeout_ms`) and
runs four at once (`max_concurrency`).

## How a Job is answered

The handler asks one question per Job and uses the Job id as the gateway
request id. The gateway keeps each request id as one durable task, so the
handler can safely ask again after a dropped connection, while the gateway is
still answering, or while its turn limit is full — each time it collects the
answer already being made rather than starting a second one. A gateway that
stays unreachable for 30 seconds is reported rather than waited on for the
whole time budget. If the integration's access level changes while an answer
is being made, the gateway withholds that answer and the handler asks once
more under the new level.

A short answer is shown whole. A longer one opens with its first paragraph and
carries the whole answer as the expanded detail, shortened only if it would
exceed Guv's 128 KiB result limit.

## Development

```sh
bun run sync-sdk    # once, and after upgrading Guv
bun test
bun run typecheck
```

The tests stub the gateway; they never reach a real one.

## License

MIT — see `LICENSE`.
