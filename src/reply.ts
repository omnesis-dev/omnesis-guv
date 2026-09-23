// SPDX-License-Identifier: MIT
// What the person sees in the Guv app for a Job: the answer, or a sentence
// saying why there is none and what to do about it. Every path ends in visible
// text; a Job never fails silently.

import { HANDLER_RESULT_MAX_BYTES, type HandlerResult } from "@familiar/guv-handler-sdk";
import { AnswerHttpError, GatewayUnreachableError, type AnswerResponse, type DenialReason } from "./answer-client.js";
import { AnswerDeadlineError } from "./ask.js";
import { ConfigError } from "./config.js";

/** Longest answer shown whole as the compact summary; a longer one is also sent in full as the detail. */
export const SUMMARY_MAX_LENGTH = 600;

const SHORTENED_MARKER = "\n\n[Shortened to fit Guv's result size limit.]";

const DENIALS: Record<DenialReason, string> = {
  privacy_policy: "Omnesis's privacy policy did not allow this answer to be shared with Guv.",
  hard_stop: "Omnesis will not share this answer: it touches something its privacy rules never release.",
  user_denied: "You declined to release this answer in Omnesis.",
  expired: "The approval for this answer expired before it was released.",
  canceled: "This question was canceled in Omnesis.",
  approval_not_available:
    "Omnesis's privacy review did not clear this answer, and Guv cannot ask you to approve it. " +
    "Ask in Omnesis directly, or change this integration's access level on the portal.",
};

export function answerReply(response: AnswerResponse): HandlerResult {
  switch (response.status) {
    case "released":
      return answerText(response.answer);
    case "released_with_reductions":
      return answerText(
        response.answer,
        response.reductions.length > 0
          ? `Omnesis withheld some details: ${response.reductions.join(", ")}.`
          : "Omnesis withheld some details.",
      );
    case "approval_required":
      return textReply("Omnesis is holding this answer for your approval. Approve it in Omnesis, then ask again.");
    case "denied":
      return textReply(DENIALS[response.reason]);
  }
}

export function errorReply(error: unknown, context: { gatewayUrl?: string; tokenFile?: string } = {}): HandlerResult {
  if (error instanceof ConfigError) {
    return textReply(`The Omnesis handler is misconfigured: ${error.message} Fix it and restart Guv.`);
  }
  if (error instanceof AnswerDeadlineError) return textReply(`${error.message} Try a narrower question.`);
  if (error instanceof GatewayUnreachableError) {
    return textReply(`${error.message} Check that the gateway is running and reachable from the Guv machine.`);
  }
  if (error instanceof AnswerHttpError) return textReply(httpErrorText(error, context));
  return textReply(`The Omnesis handler failed: ${error instanceof Error ? error.message : String(error)}`);
}

function httpErrorText(error: AnswerHttpError, context: { gatewayUrl?: string; tokenFile?: string }): string {
  switch (error.code) {
    // The gateway words these for the person: which access level, and where to choose one.
    case "ACCESS_LEVEL_REQUIRED":
    case "ACCESS_LEVEL_UNAVAILABLE":
      return error.detail;
    case "ANSWER_ACCESS_CHANGED":
      return "This integration's access level changed again while Omnesis was answering. Ask again.";
    case "ANSWER_EGRESS_LIMIT":
      return `Omnesis has released as many answers as it allows for now: ${error.detail} Try again later.`;
    case "ANSWER_CAPACITY":
    case "ANSWER_IN_PROGRESS":
      return "Omnesis is still busy with this question. Ask again in a minute.";
  }
  if (error.status === 401) {
    return (
      "Omnesis rejected this handler's token: it was revoked or is not a valid token. " +
      `Re-pair the integration and save its new token to ${context.tokenFile ?? "the handler's token file"}.`
    );
  }
  if (error.status === 403) {
    return `Omnesis refused this handler: ${error.detail}. Its token may lack the answer scope; re-pair the integration.`;
  }
  if (error.status === 404) {
    return `Omnesis has no answer endpoint at ${context.gatewayUrl ?? "the configured address"}. Check OMNESIS_GATEWAY_URL.`;
  }
  return `Omnesis could not answer (HTTP ${error.status}): ${error.detail}`;
}

/** An answer: whole when it is short, otherwise its opening as the summary and the whole answer as the detail. */
function answerText(answer: string, note?: string): HandlerResult {
  const body = answer.trim() ? answer.trim() : "Omnesis returned an empty answer.";
  const full = note ? `${body}\n\n${note}` : body;
  if (full.length <= SUMMARY_MAX_LENGTH) return textReply(full);
  return textReply(opening(body), full);
}

/** The first paragraph, cut at a word boundary to the summary length. */
function opening(text: string): string {
  const paragraph = text.split(/\n\s*\n/, 1)[0]!.trim();
  if (paragraph.length <= SUMMARY_MAX_LENGTH) return paragraph;
  const cut = paragraph.slice(0, SUMMARY_MAX_LENGTH - 1);
  const wordEnd = cut.lastIndexOf(" ");
  return `${(wordEnd > SUMMARY_MAX_LENGTH / 2 ? cut.slice(0, wordEnd) : cut).trimEnd()}…`;
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
    : outcome(summary, fit((text) => outcome(summary, text), detail));
}

function outcome(summary: string, detail?: string): HandlerResult {
  return {
    kind: "outcome_produced",
    outcome: { kind: "text", summary, ...(detail !== undefined ? { detail } : {}), artifacts: [], effects: [] },
  };
}

/** The longest prefix of `text`, plus the marker, whose result still fits. */
function fit(build: (text: string) => HandlerResult, text: string): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encodedSize(build(shorten(text, mid))) <= HANDLER_RESULT_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  return shorten(text, low);
}

function shorten(text: string, length: number): string {
  // Never split a surrogate pair: half of one is not valid UTF-8.
  const end = length > 0 && isHighSurrogate(text.charCodeAt(length - 1)) ? length - 1 : length;
  return `${text.slice(0, end).trimEnd()}${SHORTENED_MARKER}`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function encodedSize(result: HandlerResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}
