// SPDX-License-Identifier: MIT
// Map the gateway's four-state Answer response onto the compact standalone
// text Guv expects as an Outcome summary. Every state produces visible text
// so a privacy hold or denial is an answer, not a silent failure.

import type { AnswerResponse } from "./answer-client.js";

/**
 * Headroom under Guv's 128 KiB result cap. Summaries longer than this are
 * truncated on a UTF-8 boundary with an explicit marker.
 */
export const MAX_SUMMARY_BYTES = 120 * 1024;

export function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  const marker = Buffer.from("\n\n[truncated: answer exceeded the Guv result budget]", "utf8");
  let end = maxBytes - marker.length;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8") + marker.toString("utf8");
}

export function answerToSummary(result: AnswerResponse): string {
  switch (result.status) {
    case "released":
      return truncateUtf8(result.answer ?? "(Omnesis returned an empty answer.)", MAX_SUMMARY_BYTES);
    case "released_with_reductions": {
      const notes = (result.reductions ?? []).join(", ");
      const body = result.answer ?? "(Omnesis returned an empty answer.)";
      return truncateUtf8(
        `${body}\n\n[Privacy: released with reductions${notes ? `: ${notes}` : ""}]`,
        MAX_SUMMARY_BYTES,
      );
    }
    case "approval_required":
      return (
        `Omnesis held this question for approval (approval ${result.approvalId ?? "unknown"}, ` +
        `task ${result.taskId}). Approve it in Omnesis, then ask again.`
      );
    case "denied":
      return `Omnesis did not release an answer${result.reason ? `: ${result.reason}` : "."}`;
  }
}
