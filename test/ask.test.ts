// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { AnswerHttpError, GatewayUnreachableError, type AnswerRequest, type AnswerResponse } from "../src/answer-client.js";
import { AnswerDeadlineError, ask, UNREACHABLE_GIVE_UP_MS, type AskDeps } from "../src/ask.js";

const RELEASED: AnswerResponse = { status: "released", taskId: "task_1", answer: "Yes." };

/**
 * A scripted gateway on a virtual clock: each attempt takes `attemptMs` and
 * then yields the next scripted outcome; `sleep` only advances the clock.
 */
function scripted(outcomes: (AnswerResponse | Error)[], attemptMs = 0) {
  let clock = 1_000_000;
  const requests: AnswerRequest[] = [];
  const sleeps: number[] = [];
  const deps: AskDeps = {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    client: {
      submit: async (request) => {
        requests.push(request);
        clock += attemptMs;
        const next = outcomes.shift();
        if (next === undefined) throw new Error("the script ran out");
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { deps, requests, sleeps };
}

const inProgress = () => new AnswerHttpError(409, "ANSWER_IN_PROGRESS", "still answering");
const capacity = () => new AnswerHttpError(503, "ANSWER_CAPACITY", "turn limit full");
const accessChanged = () => new AnswerHttpError(403, "ANSWER_ACCESS_CHANGED", "access changed");
const unreachable = () => new GatewayUnreachableError("Cannot reach Omnesis.");

describe("ask", () => {
  test("asks once under the Job's request id", async () => {
    const { deps, requests } = scripted([RELEASED]);
    expect(await ask("Is it raining?", "job-7", 60_000, deps)).toEqual(RELEASED);
    expect(requests).toEqual([{ question: "Is it raining?", clientRequestId: "guv_job-7" }]);
  });

  test("waits out a busy gateway and a running task, with growing pauses, on the same request id", async () => {
    const { deps, requests, sleeps } = scripted([capacity(), inProgress(), inProgress(), RELEASED]);
    expect(await ask("q", "job-7", 60_000, deps)).toEqual(RELEASED);
    expect(new Set(requests.map((r) => r.clientRequestId))).toEqual(new Set(["guv_job-7"]));
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  test("pauses are capped", async () => {
    const { deps, sleeps } = scripted([...Array.from({ length: 6 }, inProgress), RELEASED]);
    await ask("q", "job-7", 600_000, deps);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });

  test("rides out a short outage, collecting the answer the gateway kept making", async () => {
    const { deps, requests } = scripted([unreachable(), unreachable(), RELEASED]);
    expect(await ask("q", "job-7", 60_000, deps)).toEqual(RELEASED);
    expect(requests).toHaveLength(3);
  });

  test("reports a gateway that stays unreachable without spending the whole budget", async () => {
    const { deps, requests } = scripted(Array.from({ length: 20 }, unreachable), 1_000);
    const error = await ask("q", "job-7", 240_000, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayUnreachableError);
    // Attempts run until the outage has lasted UNREACHABLE_GIVE_UP_MS, far short of the budget.
    expect(requests.length).toBeLessThan(10);
    expect(requests.length).toBeGreaterThan(2);
    expect(UNREACHABLE_GIVE_UP_MS).toBeLessThan(240_000);
  });

  test("an outage clock restarts once the gateway answers again", async () => {
    const { deps } = scripted(
      [unreachable(), unreachable(), unreachable(), inProgress(), unreachable(), unreachable(), RELEASED],
      8_000,
    );
    expect(await ask("q", "job-7", 600_000, deps)).toEqual(RELEASED);
  });

  test("asks again once when the access level changed mid-answer, then gives up", async () => {
    const once = scripted([accessChanged(), RELEASED]);
    expect(await ask("q", "job-7", 60_000, once.deps)).toEqual(RELEASED);
    expect(once.requests).toHaveLength(2);
    expect(once.requests[1]!.clientRequestId).toBe("guv_job-7");

    const twice = scripted([accessChanged(), accessChanged()]);
    const error = await ask("q", "job-7", 60_000, twice.deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ANSWER_ACCESS_CHANGED" });
    expect(twice.requests).toHaveLength(2);
  });

  test("does not retry a refusal waiting cannot fix", async () => {
    for (const refusal of [
      new AnswerHttpError(401, "UNAUTHORIZED", "Unauthorized"),
      new AnswerHttpError(403, "ACCESS_LEVEL_REQUIRED", "no level"),
      new AnswerHttpError(429, "ANSWER_EGRESS_LIMIT", "limit"),
      new AnswerHttpError(502, undefined, "model failed"),
      new AnswerHttpError(503, "SERVICE_UNAVAILABLE", "not serving"),
    ]) {
      const { deps, requests } = scripted([refusal]);
      expect(await ask("q", "job-7", 60_000, deps).catch((e: unknown) => e)).toBe(refusal);
      expect(requests).toHaveLength(1);
    }
  });

  test("stops at the deadline while the gateway stays busy", async () => {
    const { deps, sleeps } = scripted(Array.from({ length: 50 }, inProgress), 5_000);
    const error = await ask("q", "job-7", 30_000, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnswerDeadlineError);
    expect((error as Error).message).toBe("Omnesis did not answer within 30 seconds.");
    // No pause runs past the deadline.
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(30_000);
  });

  test("an attempt still running at the deadline is abandoned as a deadline", async () => {
    const deps: AskDeps = {
      now: Date.now,
      sleep: async () => {},
      client: {
        submit: (_request, signal) =>
          new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      },
    };
    const error = await ask("q", "job-7", 30, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnswerDeadlineError);
  });
});
