// SPDX-License-Identifier: MIT
// Guv handler: every Job becomes one privacy-brokered question to the
// Omnesis `/answer` API. Run with Bun from this directory:
//
//   bun src/handler.ts          (or `bun run handler` from the repo root)
//
// The daemon provides GUV_HANDLER_SOCKET / NONCE / IDENTITY / DAEMON_PID;
// configuration comes from OMNESIS_* env vars (see config.ts). The Guv
// handler SDK is installed separately (see README) and never committed.

import { serveHandler } from "@familiar/guv-handler-sdk/process";
import { textResult } from "@familiar/guv-handler-sdk";
import { AnswerClient, AnswerHttpError } from "./answer-client.js";
import { loadConfig } from "./config.js";
import { answerToSummary } from "./outcome.js";

/**
 * Every failure becomes user-visible text in the Guv app — the handler never
 * throws a Job away. Auth failures additionally explain how to re-pair the
 * device, since that is the fix the reader can act on.
 */
function errorText(error: unknown): string {
  if (error instanceof AnswerHttpError) {
    if (error.status === 401 || error.status === 403) {
      return [
        `Omnesis refused the request (HTTP ${error.status}): ${error.detail}.`,
        "The handler token is missing, expired, revoked, or lacks the `answer` scope.",
        "To re-authenticate the device:",
        "1. On the gateway machine: `omnesis devices pair --kind cli --scopes answer`",
        "2. On the Guv machine: `omnesis devices redeem <code> --gateway-url <gateway-url> --save <token-file>`",
        "3. Point OMNESIS_TOKEN_FILE at that file (or set OMNESIS_TOKEN) and restart the Guv daemon.",
      ].join("\n");
    }
    if (error.status === 404) {
      return (
        "Omnesis has no /answer route (HTTP 404). The gateway is older than the stable answer " +
        "surface, or OMNESIS_GATEWAY_URL points at the wrong host — check the URL first."
      );
    }
    return `Omnesis request failed (HTTP ${error.status}): ${error.detail}. Try again; if it persists, check the gateway logs.`;
  }
  return `Omnesis could not answer: ${error instanceof Error ? error.message : String(error)}`;
}

await serveHandler(async (input) => {
  const question = input.input.text ?? "";
  if (!question.trim()) {
    return textResult("Empty question from Guv; nothing to ask Omnesis.");
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    return textResult(`Handler is misconfigured: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!config.token) {
    return textResult(
      "Handler has no Omnesis token. Set OMNESIS_TOKEN or OMNESIS_TOKEN_FILE " +
        "in the daemon environment (see README).",
    );
  }
  const client = new AnswerClient({ baseUrl: config.gatewayUrl, token: config.token });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.answerTimeoutMs);
  try {
    const response = await client.submit(
      { question, clientRequestId: `guv_${input.job_id}` },
      { signal: controller.signal },
    );
    return textResult(answerToSummary(response));
  } catch (error) {
    if (controller.signal.aborted) {
      return textResult(
        `Omnesis did not answer within ${Math.round(config.answerTimeoutMs / 1000)}s; try a narrower question.`,
      );
    }
    return textResult(errorText(error));
  } finally {
    clearTimeout(timeout);
  }
});
