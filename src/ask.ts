// SPDX-License-Identifier: MIT
// Get one Guv Job's question answered within its time budget. Every attempt
// for a Job posts the same request id, so they all address one durable task on
// the gateway: posting again after a dropped connection, while the task is
// running, or while the gateway is momentarily full collects that task's
// answer, and the gateway never delivers two answers for one id.

import { AnswerHttpError, GatewayUnreachableError, type AnswerClient, type AnswerResponse } from "./answer-client.js";

const FIRST_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 10_000;

/**
 * How long the gateway may stay unreachable before the Job reports it. A
 * restart or a network blip is over well within this; a gateway that is down
 * is better reported now than at the end of the whole time budget.
 */
export const UNREACHABLE_GIVE_UP_MS = 30_000;

/** Proxy statuses that mean the gateway behind it is restarting, down, or slow to answer. */
const PROXY_GAP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Refusals that clear on their own: the task is running, or the gateway is momentarily full. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ANSWER_IN_PROGRESS",
  "ANSWER_CAPACITY",
  "QUEUE_FULL",
  "SQLITE_READONLY",
]);

/** What the Job was waiting on when its time budget ran out. */
export type DeadlineWait = "answer" | "capacity" | "gateway";

export class AnswerDeadlineError extends Error {
  override readonly name = "AnswerDeadlineError";
  constructor(
    readonly budgetMs: number,
    readonly waitingOn: DeadlineWait,
  ) {
    super(`Omnesis did not answer within ${Math.round(budgetMs / 1000)} seconds.`);
  }
}

export interface AskDeps {
  client: Pick<AnswerClient, "submit">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** A signal that aborts after `ms`, on the same clock as `now`. */
  timeout: (ms: number) => AbortSignal;
}

/**
 * The gateway request id for a Guv Job. Job ids may contain `~`, which request
 * ids may not; `:` never occurs in a Job id, so the mapping keeps distinct
 * Jobs distinct.
 */
export function requestIdFor(jobId: string): string {
  return `guv_${jobId.replaceAll("~", ":")}`;
}

export async function ask(question: string, jobId: string, budgetMs: number, deps: AskDeps): Promise<AnswerResponse> {
  const deadline = deps.now() + budgetMs;
  const request = { question, clientRequestId: requestIdFor(jobId) };
  let delay = FIRST_RETRY_DELAY_MS;
  let reaskedAfterAccessChange = false;
  let unreachableSince: number | undefined;
  let waitingOn: DeadlineWait = "answer";
  for (;;) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) throw new AnswerDeadlineError(budgetMs, waitingOn);
    const signal = deps.timeout(remaining);
    try {
      return await deps.client.submit(request, signal);
    } catch (error) {
      if (signal.aborted) throw new AnswerDeadlineError(budgetMs, waitingOn === "gateway" ? "gateway" : "answer");
      if (error instanceof AnswerHttpError && error.code === "ANSWER_ACCESS_CHANGED" && !reaskedAfterAccessChange) {
        // The integration's access level changed while the answer was being
        // made, so the gateway withheld it. The same request id asks again
        // under the new level — once: a second change is left to the person.
        reaskedAfterAccessChange = true;
        unreachableSince = undefined;
        continue;
      }
      if (error instanceof GatewayUnreachableError || isProxyGap(error)) {
        // A proxy answering for a gateway it cannot reach is an outage like any other;
        // the task, if it was created, keeps running behind it.
        waitingOn = "gateway";
        unreachableSince ??= deps.now();
        if (deps.now() - unreachableSince >= UNREACHABLE_GIVE_UP_MS) throw error;
      } else if (error instanceof AnswerHttpError && error.code !== undefined && TRANSIENT_CODES.has(error.code)) {
        waitingOn = error.code === "ANSWER_IN_PROGRESS" ? "answer" : "capacity";
        unreachableSince = undefined;
      } else {
        throw error;
      }
    }
    const now = deps.now();
    let wait = Math.min(delay, deadline - now);
    // Try once more exactly when the outage reaches its limit, not a full pause later.
    if (unreachableSince !== undefined) wait = Math.min(wait, unreachableSince + UNREACHABLE_GIVE_UP_MS - now);
    if (wait > 0) await deps.sleep(wait);
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

/** An uncoded 502/503/504: the gateway's own errors always carry a code, a proxy's do not. */
function isProxyGap(error: unknown): boolean {
  return error instanceof AnswerHttpError && error.code === undefined && PROXY_GAP_STATUSES.has(error.status);
}
