// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { HANDLER_RESULT_MAX_BYTES, HandlerResultSchema, type HandlerResult } from "@familiar/guv-handler-sdk";
import { AnswerHttpError, GatewayUnreachableError, type DenialReason } from "../src/answer-client.js";
import { AnswerDeadlineError } from "../src/ask.js";
import { ConfigError } from "../src/config.js";
import { answerReply, errorReply, SUMMARY_MAX_LENGTH, textReply } from "../src/reply.js";

function outcomeOf(result: HandlerResult) {
  // Every reply must be one Guv accepts: schema-valid and within the size limit.
  expect(HandlerResultSchema.safeParse(result).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(HANDLER_RESULT_MAX_BYTES);
  if (result.kind !== "outcome_produced") throw new Error("expected an outcome");
  return result.outcome;
}

describe("answerReply", () => {
  test("a short answer is the whole summary", () => {
    expect(outcomeOf(answerReply({ status: "released", taskId: "t", answer: "  Yes, at 3pm.  " }))).toEqual({
      kind: "text",
      summary: "Yes, at 3pm.",
      artifacts: [],
      effects: [],
    });
  });

  test("a long answer opens with its first paragraph and carries the whole answer as detail", () => {
    const answer = `First, the short version.\n\n${"More context. ".repeat(80)}`;
    const outcome = outcomeOf(answerReply({ status: "released", taskId: "t", answer }));
    expect(outcome.summary).toBe("First, the short version.");
    expect(outcome.detail).toBe(answer.trim());
  });

  test("an opening paragraph longer than the summary is cut at a word", () => {
    const answer = "word ".repeat(400);
    const { summary } = outcomeOf(answerReply({ status: "released", taskId: "t", answer }));
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH);
    expect(summary.endsWith("word…")).toBe(true);
  });

  test("an empty answer still says something", () => {
    expect(outcomeOf(answerReply({ status: "released", taskId: "t", answer: " \n" })).summary).toBe(
      "Omnesis returned an empty answer.",
    );
  });

  test("a reduced answer says what was withheld", () => {
    const outcome = outcomeOf(
      answerReply({ status: "released_with_reductions", taskId: "t", answer: "Partly.", reductions: ["names", "places"] }),
    );
    expect(outcome.summary).toBe("Partly.\n\nOmnesis withheld some details: names, places.");
  });

  test("every denial reason reads as its own sentence", () => {
    const reasons: DenialReason[] = ["privacy_policy", "hard_stop", "user_denied", "expired", "canceled", "approval_not_available"];
    const summaries = reasons.map((reason) => outcomeOf(answerReply({ status: "denied", taskId: "t", reason })).summary);
    expect(new Set(summaries).size).toBe(reasons.length);
  });

  test("a held answer says how to release it", () => {
    expect(outcomeOf(answerReply({ status: "approval_required", taskId: "t", approvalId: "ap" })).summary).toContain(
      "Approve it in Omnesis",
    );
  });
});

describe("textReply", () => {
  test("measures the encoded result, so heavy escaping still fits", () => {
    // Each of these characters costs 2–6 bytes once JSON-encoded.
    const escaped = '"\\\n\u0001'.repeat(HANDLER_RESULT_MAX_BYTES / 4);
    const outcome = outcomeOf(textReply(escaped));
    expect(outcome.summary.endsWith("[Shortened to fit Guv's result size limit.]")).toBe(true);
  });

  test("cuts the detail, not the summary, when a long answer overflows, keeping as much as fits", () => {
    const result = textReply("The gist.", "é".repeat(HANDLER_RESULT_MAX_BYTES));
    const outcome = outcomeOf(result);
    expect(outcome.summary).toBe("The gist.");
    expect(outcome.detail!.endsWith("[Shortened to fit Guv's result size limit.]")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(HANDLER_RESULT_MAX_BYTES - 4);
  });

  test("never splits a surrogate pair", () => {
    const { summary } = outcomeOf(textReply("🙂".repeat(HANDLER_RESULT_MAX_BYTES)));
    expect(summary.isWellFormed()).toBe(true);
  });
});

describe("errorReply", () => {
  const context = { gatewayUrl: "https://gateway.example.org:7600", tokenFile: "/secure/guv.token" };
  const summary = (error: unknown) => outcomeOf(errorReply(error, context)).summary;

  test("says what went wrong and what to do about it", () => {
    expect(summary(new ConfigError("OMNESIS_TOKEN_FILE is not set."))).toBe(
      "The Omnesis handler is misconfigured: OMNESIS_TOKEN_FILE is not set. Fix it and restart Guv.",
    );
    expect(summary(new AnswerDeadlineError(240_000))).toBe(
      "Omnesis did not answer within 240 seconds. Try a narrower question.",
    );
    expect(summary(new GatewayUnreachableError("Cannot reach Omnesis at https://gateway.example.org:7600 (refused)."))).toBe(
      "Cannot reach Omnesis at https://gateway.example.org:7600 (refused). Check that the gateway is running and reachable from the Guv machine.",
    );
    expect(summary(new AnswerHttpError(401, "UNAUTHORIZED", "Unauthorized"))).toContain("/secure/guv.token");
    expect(summary(new AnswerHttpError(404, "NOT_FOUND", "Not found"))).toContain("https://gateway.example.org:7600");
    expect(summary(new AnswerHttpError(500, "INTERNAL", "boom"))).toBe("Omnesis could not answer (HTTP 500): boom");
    expect(summary(new Error("unexpected"))).toBe("The Omnesis handler failed: unexpected");
  });

  test("passes through the gateway's own words for an integration without a usable access level", () => {
    const detail = "This integration has no access level yet. Choose one on the portal's Devices page.";
    expect(summary(new AnswerHttpError(403, "ACCESS_LEVEL_REQUIRED", detail))).toBe(detail);
    expect(summary(new AnswerHttpError(403, "ACCESS_LEVEL_UNAVAILABLE", detail))).toBe(detail);
  });

  test("a 403 without an access-level code points at the token's scope", () => {
    expect(summary(new AnswerHttpError(403, "FORBIDDEN", "answer scope required"))).toContain("answer scope");
  });
});
