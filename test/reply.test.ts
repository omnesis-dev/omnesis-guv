// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { HANDLER_RESULT_MAX_BYTES, HandlerResultSchema, type HandlerResult } from "@familiar/guv-handler-sdk";
import {
  AnswerHttpError,
  GatewayCertificateError,
  GatewayRedirectError,
  GatewayUnreachableError,
  InvalidAnswerResponseError,
} from "../src/answer-client.js";
import { AnswerDeadlineError } from "../src/ask.js";
import { ConfigError, JobFileError } from "../src/config.js";
import { answerReply, configErrorReply, errorReply, SUMMARY_MAX_LENGTH, textReply } from "../src/reply.js";

const MARKER = "[Shortened to fit Guv's result size limit.]";

/** Every reply must be one Guv accepts: schema-valid, well-formed UTF-16, and within the size limit. */
function outcomeOf(result: HandlerResult) {
  expect(HandlerResultSchema.safeParse(result).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(HANDLER_RESULT_MAX_BYTES);
  if (result.kind !== "outcome_produced") throw new Error("expected an outcome");
  expect(result.outcome.summary.isWellFormed()).toBe(true);
  expect((result.outcome.detail ?? "").isWellFormed()).toBe(true);
  return result.outcome;
}

const released = (answer: string) => answerReply({ status: "released", taskId: "t", answer });

describe("answerReply", () => {
  test("a short answer is the whole summary", () => {
    expect(outcomeOf(released("  Yes, at 3pm.  "))).toEqual({
      kind: "text",
      summary: "Yes, at 3pm.",
      artifacts: [],
      effects: [],
    });
  });

  test("a long answer opens with the whole paragraphs that fit and carries the whole answer as detail", () => {
    const answer = `Here are your meetings:\n\nStand-up at 9.\n\n${"More context. ".repeat(80)}`;
    const outcome = outcomeOf(released(answer));
    expect(outcome.summary).toBe("Here are your meetings:\n\nStand-up at 9.");
    expect(outcome.detail).toBe(answer.trim());
  });

  test("an opening paragraph longer than the summary is cut at a word", () => {
    const { summary } = outcomeOf(released("word ".repeat(400)));
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH);
    expect(summary.endsWith("word…")).toBe(true);
  });

  test("the summary cut never splits a surrogate pair", () => {
    for (let at = SUMMARY_MAX_LENGTH - 4; at <= SUMMARY_MAX_LENGTH; at++) {
      outcomeOf(released(`${"x".repeat(at)}🙂${"y".repeat(SUMMARY_MAX_LENGTH)}`));
    }
  });

  test("an empty answer still says something", () => {
    expect(outcomeOf(released(" \n")).summary).toBe("Omnesis returned an empty answer.");
  });

  test("withheld details are listed as sentences after the answer", () => {
    const outcome = outcomeOf(
      answerReply({
        status: "released_with_reductions",
        taskId: "t",
        answer: "Partly.",
        reductions: ["Names were generalized", "Addresses were removed."],
      }),
    );
    expect(outcome.summary).toBe(
      "Partly.\n\nOmnesis withheld some details:\n- Names were generalized.\n- Addresses were removed.",
    );
  });

  test("a split summary still flags withheld details", () => {
    const outcome = outcomeOf(
      answerReply({
        status: "released_with_reductions",
        taskId: "t",
        answer: "word ".repeat(400),
        reductions: ["Names"],
      }),
    );
    expect(outcome.summary.endsWith("(Some details were withheld.)")).toBe(true);
    expect(outcome.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH);
    expect(outcome.detail).toContain("Omnesis withheld some details:\n- Names.");
  });

  test("every denial reason reads as its own sentence, and an unknown one as a plain denial", () => {
    const reasons = ["privacy_policy", "hard_stop", "user_denied", "expired", "canceled", "approval_not_available"];
    const summaries = reasons.map(
      (reason) => outcomeOf(answerReply({ status: "denied", taskId: "t", reason })).summary,
    );
    expect(new Set(summaries).size).toBe(reasons.length);
    expect(outcomeOf(answerReply({ status: "denied", taskId: "t", reason: "newer_reason" })).summary).toBe(
      "Omnesis did not release an answer to this question.",
    );
  });

  test("a held answer says where to read it", () => {
    expect(outcomeOf(answerReply({ status: "approval_required", taskId: "t", approvalId: "ap" })).summary).toContain(
      "Read it in Omnesis once you approve it",
    );
  });
});

describe("textReply", () => {
  test("measures the encoded result, so heavy escaping still fits", () => {
    // Each of these characters costs 2 to 6 bytes once JSON-encoded.
    const escaped = '"\\\n\u0001'.repeat(HANDLER_RESULT_MAX_BYTES / 4);
    expect(outcomeOf(textReply(escaped)).summary.endsWith(MARKER)).toBe(true);
  });

  test("cuts the detail, not the summary, when a long answer overflows, keeping as much as fits", () => {
    const result = textReply("The gist.", "é".repeat(HANDLER_RESULT_MAX_BYTES));
    const outcome = outcomeOf(result);
    expect(outcome.summary).toBe("The gist.");
    expect(outcome.detail!.endsWith(MARKER)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(HANDLER_RESULT_MAX_BYTES - 4);
  });

  test("never splits a surrogate pair when shortening", () => {
    outcomeOf(textReply("🙂".repeat(HANDLER_RESULT_MAX_BYTES)));
  });

  test("never sends a blank or malformed field", () => {
    expect(outcomeOf(textReply("   ")).summary).toBe("Omnesis sent an empty reply.");
    expect(outcomeOf(textReply("Gist.", " ")).detail).toBeUndefined();
    expect(outcomeOf(textReply("lone \ud83d surrogate")).summary).toBe("lone � surrogate");
  });
});

describe("errorReply", () => {
  const config = { gatewayUrl: "https://gateway.example.org:7600", tokenFile: "/secure/guv.token" };
  const summary = (error: unknown) => outcomeOf(errorReply(error, config)).summary;

  test("says what went wrong and what to do about it", () => {
    expect(summary(new JobFileError("The Omnesis token file /secure/guv.token is empty."))).toBe(
      "The Omnesis token file /secure/guv.token is empty. Fix the file; the next question reads it again.",
    );
    expect(summary(new GatewayUnreachableError(config.gatewayUrl, "ConnectionRefused"))).toBe(
      "Cannot reach Omnesis at https://gateway.example.org:7600 (ConnectionRefused). " +
        "Check that the gateway is running and reachable from the Guv machine.",
    );
    expect(summary(new GatewayCertificateError("DEPTH_ZERO_SELF_SIGNED_CERT"))).toContain("--ca-file");
    expect(summary(new GatewayCertificateError("ERR_TLS_CERT_ALTNAME_INVALID"))).toContain(
      "an address the gateway's certificate names",
    );
    expect(summary(new GatewayRedirectError("https://other.example.org/"))).toContain("--gateway-url");
    expect(summary(new InvalidAnswerResponseError())).toContain("--gateway-url points at the Omnesis gateway");
    expect(summary(new AnswerHttpError(401, "UNAUTHORIZED", "Unauthorized"))).toContain("/secure/guv.token");
    expect(summary(new AnswerHttpError(500, "INTERNAL", "boom"))).toBe("Omnesis could not answer (HTTP 500): boom.");
    expect(summary(new Error("unexpected"))).toBe("The Omnesis handler failed: unexpected.");
  });

  test("advice on a deadline follows what the Job was waiting on", () => {
    expect(summary(new AnswerDeadlineError(240_000, "answer"))).toBe(
      "Omnesis did not answer within 240 seconds. It may have been too broad a question; try a narrower one.",
    );
    expect(summary(new AnswerDeadlineError(240_000, "capacity"))).toContain("busy with other questions");
    expect(summary(new AnswerDeadlineError(240_000, "gateway"))).toContain("stopped responding");
  });

  test("an integration without a usable access level is told where to choose one", () => {
    const required = "This integration has no access level yet. Choose one on the portal's Devices page.";
    expect(summary(new AnswerHttpError(403, "ACCESS_LEVEL_REQUIRED", required))).toBe(required);
    expect(
      summary(
        new AnswerHttpError(
          403,
          "ACCESS_LEVEL_UNAVAILABLE",
          "This device's access level can no longer answer questions",
        ),
      ),
    ).toBe(
      "This device's access level can no longer answer questions. " +
        "Choose another access level on the integration's card on the portal's Devices page.",
    );
  });

  test("a 404 is a wrong address only when the gateway did not send one of its own", () => {
    expect(summary(new AnswerHttpError(404, undefined, "Not Found"))).toBe(
      "There is no Omnesis answer endpoint at https://gateway.example.org:7600. Check --gateway-url.",
    );
    expect(summary(new AnswerHttpError(404, "NOT_FOUND", "conversation not found"))).toBe(
      "Omnesis could not answer (HTTP 404): conversation not found.",
    );
  });

  test("a 403 without an access-level code points at the token's scope", () => {
    expect(summary(new AnswerHttpError(403, "FORBIDDEN", "answer scope required."))).toBe(
      "Omnesis refused this handler: answer scope required. Its token may lack the answer scope; pair the integration again.",
    );
  });
});

describe("configErrorReply", () => {
  test("names the problem and how to apply the fix", () => {
    expect(
      outcomeOf(configErrorReply(new ConfigError("--gateway-url is missing from the handler's command."))).summary,
    ).toBe(
      "The Omnesis handler's command is wrong: --gateway-url is missing from the handler's command. " +
        "Fix it in the handler configuration, load it into Guv again, and restart Guv.",
    );
  });
});
