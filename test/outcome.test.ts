// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { answerToSummary, MAX_SUMMARY_BYTES, truncateUtf8 } from "../src/outcome.js";
import type { AnswerResponse } from "../src/answer-client.js";

const IDS = { workflowId: "wf", conversationId: "conv", taskId: "task" };

describe("answerToSummary", () => {
  test("released returns the answer verbatim", () => {
    const out = answerToSummary({ status: "released", answer: "yes", ...IDS });
    expect(out).toBe("yes");
  });

  test("released_with_reductions appends the privacy note", () => {
    const out = answerToSummary({
      status: "released_with_reductions",
      answer: "partial",
      reductions: ["names"],
      ...IDS,
    } as AnswerResponse);
    expect(out).toContain("partial");
    expect(out).toContain("names");
  });

  test("denied and approval_required stay visible, never empty", () => {
    expect(answerToSummary({ status: "denied", reason: "policy", ...IDS })).toContain("policy");
    expect(
      answerToSummary({ status: "approval_required", approvalId: "a1", ...IDS }),
    ).toContain("a1");
  });

  test("long answers truncate inside the byte budget", () => {
    const big = "x".repeat(MAX_SUMMARY_BYTES + 1000);
    const out = truncateUtf8(big, MAX_SUMMARY_BYTES);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
    expect(out).toContain("[truncated");
  });
});
