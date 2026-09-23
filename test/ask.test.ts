// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import {
  AnswerHttpError,
  GatewayUnreachableError,
  type AnswerRequest,
  type AnswerResponse,
} from "../src/answer-client.js";
import {
  AnswerDeadlineError,
  ask,
  OUTAGE_GIVE_UP_MS,
  OUTAGE_PROBE_MS,
  requestIdFor,
  type AskDeps,
} from "../src/ask.js";

const RELEASED: AnswerResponse = { status: "released", taskId: "task_1", answer: "Yes." };

/** A scripted attempt that never returns: it runs until its deadline signal fires. */
const HANG = Symbol("hang");

/**
 * A scripted gateway on a virtual clock. Each attempt takes `attemptMs`, then
 * yields the next scripted outcome — unless the attempt's deadline signal
 * fires first, which it does on the same virtual clock.
 */
function scripted(outcomes: (AnswerResponse | Error | typeof HANG)[], attemptMs = 0) {
  const start = 1_000_000;
  let clock = start;
  const requests: AnswerRequest[] = [];
  const sleeps: number[] = [];
  const deadlines = new Map<AbortSignal, { controller: AbortController; at: number }>();
  const deps: AskDeps = {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    timeout: (ms) => {
      const controller = new AbortController();
      deadlines.set(controller.signal, { controller, at: clock + ms });
      return controller.signal;
    },
    client: {
      submit: async (request, signal) => {
        requests.push(request);
        const deadline = deadlines.get(signal)!;
        if (outcomes[0] === HANG || clock + attemptMs >= deadline.at) {
          if (outcomes[0] === HANG) outcomes.shift();
          clock = deadline.at;
          deadline.controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
          throw signal.reason;
        }
        clock += attemptMs;
        const next = outcomes.shift();
        if (next === undefined || next === HANG) throw new Error("the script ran out");
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { deps, requests, sleeps, elapsed: () => clock - start };
}

const inProgress = () => new AnswerHttpError(409, "ANSWER_IN_PROGRESS", "still answering");
const capacity = () => new AnswerHttpError(503, "ANSWER_CAPACITY", "turn limit full");
const accessChanged = () => new AnswerHttpError(403, "ANSWER_ACCESS_CHANGED", "access changed");
const unreachable = () => new GatewayUnreachableError("https://gateway.example.org:7600", "ConnectionRefused");

describe("requestIdFor", () => {
  test("keeps Job ids distinct while making every one a valid gateway request id", () => {
    const gatewayRequestId = /^[A-Za-z0-9_.:-]{1,160}$/;
    const jobIds = ["job-7", "a~b", "~", `${"x".repeat(127)}~`];
    for (const jobId of jobIds) expect(requestIdFor(jobId)).toMatch(gatewayRequestId);
    expect(requestIdFor("a~b")).toBe("guv_a:b");
    expect(requestIdFor("a~b")).not.toBe(requestIdFor("a-b"));
  });
});

describe("ask", () => {
  test("asks once under the Job's request id", async () => {
    const { deps, requests } = scripted([RELEASED]);
    expect(await ask("Is it raining?", "job~7", 60_000, deps)).toEqual(RELEASED);
    expect(requests).toEqual([{ question: "Is it raining?", clientRequestId: "guv_job:7" }]);
  });

  test("waits out a running task and a full gateway, with growing pauses, on the same request id", async () => {
    const { deps, requests, sleeps } = scripted([
      capacity(),
      inProgress(),
      new AnswerHttpError(503, "QUEUE_FULL", "try again in a moment"),
      new AnswerHttpError(503, "SQLITE_READONLY", "try again in a moment"),
      RELEASED,
    ]);
    expect(await ask("q", "job-7", 60_000, deps)).toEqual(RELEASED);
    expect(new Set(requests.map((r) => r.clientRequestId))).toEqual(new Set(["guv_job-7"]));
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000]);
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

  test("reports a gateway that stays unreachable once the outage reaches its limit, not at the deadline", async () => {
    const outage = Array.from({ length: 20 }, unreachable);
    const { deps, elapsed } = scripted(outage, 1_000);
    const error = await ask("q", "job-7", 240_000, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayUnreachableError);
    // The last attempt starts exactly when the outage reaches its limit.
    expect(elapsed()).toBeGreaterThanOrEqual(OUTAGE_GIVE_UP_MS);
    expect(elapsed()).toBeLessThanOrEqual(OUTAGE_GIVE_UP_MS + 2 * 1_000);
  });

  test("waits out a proxy answering for a gateway that is restarting or slow", async () => {
    const { deps, requests } = scripted([
      new AnswerHttpError(502, undefined, "Bad Gateway"),
      new AnswerHttpError(504, undefined, "Gateway Timeout"),
      inProgress(),
      RELEASED,
    ]);
    expect(await ask("q", "job-7", 60_000, deps)).toEqual(RELEASED);
    expect(requests).toHaveLength(4);
  });

  test("waits out a gateway shutting down for a restart", async () => {
    const { deps, requests } = scripted([
      new AnswerHttpError(503, "GATEWAY_SHUTTING_DOWN", "Gateway is shutting down"),
      unreachable(),
      RELEASED,
    ]);
    expect(await ask("q", "job-7", 60_000, deps)).toEqual(RELEASED);
    expect(requests).toHaveLength(3);
  });

  test("an access change resets what a later deadline reports", async () => {
    const { deps } = scripted([unreachable(), accessChanged(), HANG]);
    expect(await ask("q", "job-7", 20_000, deps).catch((e: unknown) => e)).toMatchObject({ waitingOn: "answer" });
  });

  test("a gateway that went dark is reported once the outage reaches its limit, not after hanging to the deadline", async () => {
    // Refused once, then every connection hangs: an asleep or disconnected machine.
    const { deps, requests, elapsed } = scripted([unreachable(), HANG, HANG, HANG, HANG, HANG, HANG]);
    const error = await ask("q", "job-7", 240_000, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayUnreachableError);
    expect(elapsed()).toBeLessThanOrEqual(OUTAGE_GIVE_UP_MS + OUTAGE_PROBE_MS);
    expect(requests.length).toBeGreaterThan(2);
  });

  test("a gateway that comes back mid-outage still delivers the answer a probe started", async () => {
    // The probe reaches the recovered gateway, which starts the task and is still
    // answering when the probe gives up; the next probe finds it running.
    const { deps, requests } = scripted([unreachable(), HANG, inProgress(), inProgress(), RELEASED]);
    expect(await ask("q", "job-7", 240_000, deps)).toEqual(RELEASED);
    expect(new Set(requests.map((r) => r.clientRequestId))).toEqual(new Set(["guv_job-7"]));
  });

  test("a deadline that falls during a probe is reported as the gateway", async () => {
    const { deps } = scripted([unreachable(), HANG, HANG]);
    const error = await ask("q", "job-7", 15_000, deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AnswerDeadlineError", waitingOn: "gateway" });
  });

  test("a deadline that falls during a pause after an outage is reported as the gateway", async () => {
    const { deps } = scripted(Array.from({ length: 5 }, unreachable), 4_000);
    const error = await ask("q", "job-7", 10_000, deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AnswerDeadlineError", waitingOn: "gateway" });
  });

  test("a gateway that stays unavailable is reported with its last answer, whatever mix the outage was", async () => {
    const outage = [
      unreachable(),
      new AnswerHttpError(502, undefined, "Bad Gateway"),
      new AnswerHttpError(503, "GATEWAY_SHUTTING_DOWN", "Gateway is shutting down"),
      ...Array.from({ length: 20 }, () => new AnswerHttpError(502, undefined, "Bad Gateway")),
    ];
    const { deps, elapsed } = scripted(outage, 1_000);
    const error = await ask("q", "job-7", 240_000, deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AnswerHttpError", status: 502, code: undefined });
    expect(elapsed()).toBeGreaterThanOrEqual(OUTAGE_GIVE_UP_MS);
    expect(elapsed()).toBeLessThanOrEqual(OUTAGE_GIVE_UP_MS + 2 * 1_000);
  });

  test("an outage clock restarts once the gateway answers again", async () => {
    const { deps } = scripted(
      [unreachable(), unreachable(), unreachable(), inProgress(), unreachable(), unreachable(), RELEASED],
      8_000,
    );
    expect(await ask("q", "job-7", 600_000, deps)).toEqual(RELEASED);
  });

  test("asks again once when the access level changed mid-answer, then gives up", async () => {
    const once = scripted([inProgress(), accessChanged(), RELEASED]);
    expect(await ask("q", "job-7", 60_000, once.deps)).toEqual(RELEASED);
    expect(once.requests.map((r) => r.clientRequestId)).toEqual(["guv_job-7", "guv_job-7", "guv_job-7"]);

    const twice = scripted([accessChanged(), inProgress(), accessChanged()]);
    const error = await ask("q", "job-7", 60_000, twice.deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ANSWER_ACCESS_CHANGED" });
    expect(twice.requests).toHaveLength(3);
  });

  test("does not retry a refusal waiting cannot fix", async () => {
    for (const refusal of [
      new AnswerHttpError(401, "UNAUTHORIZED", "Unauthorized"),
      new AnswerHttpError(403, "ACCESS_LEVEL_REQUIRED", "no level"),
      new AnswerHttpError(429, "ANSWER_EGRESS_LIMIT", "limit"),
      new AnswerHttpError(502, "BAD_GATEWAY", "model failed"),
      new AnswerHttpError(503, "SERVICE_UNAVAILABLE", "not serving"),
    ]) {
      const { deps, requests } = scripted([refusal]);
      expect(await ask("q", "job-7", 60_000, deps).catch((e: unknown) => e)).toBe(refusal);
      expect(requests).toHaveLength(1);
    }
  });

  test("stops exactly at the deadline, saying what it was waiting on", async () => {
    const busy = scripted(Array.from({ length: 50 }, capacity), 5_000);
    const error = await ask("q", "job-7", 30_000, busy.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnswerDeadlineError);
    expect((error as Error).message).toBe("Omnesis did not answer within 30 seconds.");
    expect(error).toMatchObject({ waitingOn: "capacity" });
    expect(busy.elapsed()).toBe(30_000);

    const running = scripted(Array.from({ length: 50 }, inProgress), 5_000);
    expect(await ask("q", "job-7", 30_000, running.deps).catch((e: unknown) => e)).toMatchObject({
      waitingOn: "answer",
    });
  });

  test("an attempt still running at the deadline is abandoned there", async () => {
    const { deps, requests, elapsed } = scripted([RELEASED], 90_000);
    const error = await ask("q", "job-7", 30_000, deps).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "AnswerDeadlineError", waitingOn: "answer" });
    expect(requests).toHaveLength(1);
    expect(elapsed()).toBe(30_000);
  });
});
