// SPDX-License-Identifier: MIT
// What the person sees in the Guv app for a Job: the answer, or a sentence
// saying why there is none and what to do about it. Every path ends in visible
// text; a Job never fails silently.

import { HANDLER_RESULT_MAX_BYTES, type HandlerResult } from "@familiar/guv-handler-sdk";
import {
  AnswerHttpError,
  GatewayCertificateError,
  GatewayRedirectError,
  GatewayUnreachableError,
  InvalidAnswerResponseError,
  type AnswerResponse,
} from "./answer-client.js";
import { AnswerDeadlineError, isGatewayOutage, type DeadlineWait } from "./ask.js";
import { JobFileError, type ConfigError, type HandlerConfig } from "./config.js";

/** Longest answer shown whole as the compact summary; a longer one is also sent in full as the detail. */
export const SUMMARY_MAX_LENGTH = 600;

const SHORTENED_MARKER = "\n\n[Shortened to fit Guv's result size limit.]";

const DENIALS: Record<string, string> = {
  privacy_policy: "Omnesis's privacy policy did not allow this answer to be shared with Guv.",
  hard_stop: "Omnesis will not share this answer: it touches something its privacy rules never release.",
  user_denied: "You declined to release this answer in Omnesis.",
  expired: "The approval for this answer expired before it was released.",
  canceled: "This question was canceled in Omnesis.",
  approval_not_available:
    "Omnesis's privacy review did not clear this answer, and Guv cannot ask you to approve it. " +
    "Ask in Omnesis directly, or change this integration's access level on the portal.",
};

const DEADLINE_ADVICE: Record<DeadlineWait, string> = {
  answer: "It may have been too broad a question; try a narrower one.",
  capacity: "Omnesis was busy with other questions; ask again shortly.",
  gateway: "The gateway stopped responding; check that it is running and reachable from the Guv machine.",
};

export function answerReply(response: AnswerResponse): HandlerResult {
  switch (response.status) {
    case "released":
      return answerText(response.answer, []);
    case "released_with_reductions":
      return answerText(response.answer, response.reductions);
    case "approval_required":
      // The handler asks with approval "never", so the gateway should not hold an answer.
      return textReply(
        "Omnesis held this answer for approval, which Guv cannot give. Read it in Omnesis once you approve it.",
      );
    case "denied":
      return textReply(
        Object.hasOwn(DENIALS, response.reason)
          ? DENIALS[response.reason]!
          : "Omnesis did not release an answer to this question.",
      );
  }
}

/** A configuration problem found at startup, reported on every Job until it is fixed. */
export function configErrorReply(error: ConfigError): HandlerResult {
  return textReply(
    `The Omnesis handler's command is wrong: ${sentence(error.message)} ` +
      "Fix it in the handler configuration, load it into Guv again, and restart Guv.",
  );
}

export function errorReply(error: unknown, config: Pick<HandlerConfig, "gatewayUrl" | "tokenFile">): HandlerResult {
  if (error instanceof JobFileError) {
    return textReply(`${sentence(error.message)} Fix the file; the next question reads it again.`);
  }
  if (error instanceof AnswerDeadlineError) {
    return textReply(`${sentence(error.message)} ${DEADLINE_ADVICE[error.waitingOn]}`);
  }
  if (error instanceof GatewayUnreachableError) {
    return textReply(
      `${sentence(error.message)} Check that the gateway is running and reachable from the Guv machine.`,
    );
  }
  if (error instanceof AnswerHttpError && isGatewayOutage(error)) {
    // An outage whose last word was an HTTP answer: a proxy, or a gateway shutting down.
    return textReply(
      `The Omnesis gateway at ${config.gatewayUrl} stayed unavailable (HTTP ${error.status}: ${error.detail.trim().replace(/[.!?]+$/, "")}). ` +
        "Check that it is running and reachable from the Guv machine.",
    );
  }
  if (error instanceof GatewayCertificateError) {
    return textReply(
      `${sentence(error.message)} ${
        error.code === "ERR_TLS_CERT_ALTNAME_INVALID"
          ? "Set --gateway-url to an address the gateway's certificate names."
          : "If the gateway uses its own certificate authority, pass its CA bundle with --ca-file."
      }`,
    );
  }
  if (error instanceof GatewayRedirectError) {
    return textReply(`${sentence(error.message)} Set --gateway-url to the gateway's own address.`);
  }
  if (error instanceof InvalidAnswerResponseError) {
    return textReply(
      `${sentence(error.message)} Check that --gateway-url points at the Omnesis gateway, and update omnesis-guv.`,
    );
  }
  if (error instanceof AnswerHttpError) return textReply(httpErrorText(error, config));
  return textReply(`The Omnesis handler failed: ${sentence(error instanceof Error ? error.message : String(error))}`);
}

function httpErrorText(error: AnswerHttpError, config: Pick<HandlerConfig, "gatewayUrl" | "tokenFile">): string {
  const detail = sentence(error.detail);
  switch (error.code) {
    case "ACCESS_LEVEL_REQUIRED":
      // The gateway words this one for the person, including where to choose a level.
      return detail;
    case "ACCESS_LEVEL_UNAVAILABLE":
      return `${detail} Choose another access level on the integration's card on the portal's Devices page.`;
    case "ANSWER_ACCESS_CHANGED":
      return "This integration's access level changed again while Omnesis was answering. Ask again.";
    case "ANSWER_EGRESS_LIMIT":
      return `${detail} Ask again to start a new answer.`;
  }
  if (error.status === 401) {
    return (
      "Omnesis rejected this handler's token: it was revoked or is not a valid token. " +
      `Pair the integration again and save its new token to ${config.tokenFile}.`
    );
  }
  if (error.status === 403) {
    return `Omnesis refused this handler: ${detail} Its token may lack the answer scope; pair the integration again.`;
  }
  // The gateway sends a coded 404 for its own records; an uncoded one means no such route.
  if (error.status === 404 && error.code === undefined) {
    return `There is no Omnesis answer endpoint at ${config.gatewayUrl}. Check --gateway-url.`;
  }
  return `Omnesis could not answer (HTTP ${error.status}): ${detail}`;
}

/**
 * An answer: whole when it is short; otherwise its opening as the summary and
 * the whole answer as the detail. Withheld details are listed after the answer
 * and flagged in a split summary, so compact surfaces show them too.
 */
function answerText(answer: string, reductions: readonly string[]): HandlerResult {
  const body = answer.trim() || "Omnesis returned an empty answer.";
  const withheld = reductions.map((reduction) => reduction.trim()).filter(Boolean);
  const note =
    withheld.length > 0
      ? ["Omnesis withheld some details:", ...withheld.map((r) => `- ${sentence(r)}`)].join("\n")
      : "";
  const full = note ? `${body}\n\n${note}` : body;
  if (full.length <= SUMMARY_MAX_LENGTH) return textReply(full);
  const flag = note ? " (Some details were withheld.)" : "";
  return textReply(`${opening(body, SUMMARY_MAX_LENGTH - flag.length)}${flag}`, full);
}

/**
 * The answer's opening: as many whole paragraphs as fit in `max` characters,
 * or, when even the first does not fit, that paragraph cut at a word boundary
 * and marked with "…".
 */
function opening(text: string, max: number): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  let kept = "";
  for (const paragraph of paragraphs) {
    const next = kept ? `${kept}\n\n${paragraph}` : paragraph;
    if (next.length > max) break;
    kept = next;
  }
  if (kept) return kept;
  const cut = cutAt(paragraphs[0]!, max - 1);
  const wordEnd = cut.lastIndexOf(" ");
  return `${(wordEnd > max / 2 ? cut.slice(0, wordEnd) : cut).trimEnd()}…`;
}

/**
 * A text Outcome that fits Guv's result limit. The limit applies to the
 * encoded JSON, where escaping can double a string's size, so it is measured
 * rather than estimated. A detail only ever accompanies a short summary, so
 * the detail is what gets cut, from the end and with a marker.
 */
export function textReply(summary: string, detail?: string): HandlerResult {
  const result = outcome(summary, detail);
  if (encodedSize(result) <= HANDLER_RESULT_MAX_BYTES) return result;
  return detail === undefined
    ? outcome(fit((text) => outcome(text), summary))
    : outcome(
        summary,
        fit((text) => outcome(summary, text), detail),
      );
}

function outcome(summary: string, detail?: string): HandlerResult {
  // Guv rejects a blank summary or detail and invalid UTF-8, and a rejected
  // result restarts the handler, so neither ever leaves here.
  return {
    kind: "outcome_produced",
    outcome: {
      kind: "text",
      summary: summary.trim() ? summary.toWellFormed() : "Omnesis sent an empty reply.",
      ...(detail?.trim() ? { detail: detail.toWellFormed() } : {}),
      artifacts: [],
      effects: [],
    },
  };
}

/** The longest prefix of `text`, plus the marker, whose result still fits. */
function fit(build: (text: string) => HandlerResult, text: string): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encodedSize(build(shortened(text, mid))) <= HANDLER_RESULT_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  return shortened(text, low);
}

function shortened(text: string, length: number): string {
  return `${cutAt(text, length).trimEnd()}${SHORTENED_MARKER}`;
}

/** `text` cut to at most `length` UTF-16 units, never between the halves of a surrogate pair. */
function cutAt(text: string, length: number): string {
  if (length >= text.length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/** `text` as one sentence: trimmed, ending in punctuation. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function encodedSize(result: HandlerResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}
