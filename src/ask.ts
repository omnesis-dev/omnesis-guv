// SPDX-License-Identifier: MIT
// Get one Guv Job's question answered within its time budget. The Job id
// becomes the gateway request id, so every attempt for a Job is the same
// durable task on the gateway: re-posting after a dropped connection or a
// busy gateway collects the answer already being made, never a second one.

import { AnswerHttpError, GatewayUnreachableError, type AnswerResponse, type AnswerClient } from "./answer-client.js";

/** The gateway's `/answer` question limit, in UTF-16 code units. */
export const MAX_QUESTION_LENGTH = 10_000;

const FIRST_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 10_000;
/**
 * How long the gateway may stay unreachable before the Job reports it. A
 * restart or a network blip is over well within this; a gateway that is down
 * is better reported now than at the end of the whole time budget.
 */
export const UNREACHABLE_GIVE_UP_MS = 30_000;

/** The time budget ran out before the gateway returned a verdict. */
export class AnswerDeadlineError extends Error {
  override readonly name = "AnswerDeadlineError";
  constructor(readonly budgetMs: number) {
    super(`Omnesis did not answer within ${Math.round(budgetMs / 1000)} seconds.`);
  }
}

export interface AskDeps {
  client: Pick<AnswerClient, "submit">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export async function ask(
  question: string,
  jobId: string,
  budgetMs: number,
  deps: AskDeps,
): Promise<AnswerResponse> {
  const deadline = deps.now() + budgetMs;
  const request = { question, clientRequestId: `guv_${jobId}` };
  let delay = FIRST_RETRY_DELAY_MS;
  let reaskedAfterAccessChange = false;
  let unreachableSince: number | undefined;
  for (;;) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) throw new AnswerDeadlineError(budgetMs);
    const signal = AbortSignal.timeout(remaining);
    try {
      return await deps.client.submit(request, signal);
    } catch (error) {
      if (signal.aborted) throw new AnswerDeadlineError(budgetMs);
      if (error instanceof GatewayUnreachableError) {
        unreachableSince ??= deps.now();
        if (deps.now() - unreachableSince >= UNREACHABLE_GIVE_UP_MS) throw error;
      } else {
        unreachableSince = undefined;
      }
      if (isAccessChange(error) && !reaskedAfterAccessChange) {
        // The integration's access level changed while the answer was being
        // made, so the gateway withheld it. The same request id asks again
        // under the new level — once: a second change is left to the person.
        reaskedAfterAccessChange = true;
        continue;
      }
      if (!isWorthWaitingOut(error)) throw error;
    }
    const wait = Math.min(delay, deadline - deps.now());
    if (wait <= 0) throw new AnswerDeadlineError(budgetMs);
    await deps.sleep(wait);
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

function isAccessChange(error: unknown): boolean {
  return error instanceof AnswerHttpError && error.code === "ANSWER_ACCESS_CHANGED";
}

/**
 * Failures that end on their own: the connection dropped (the task keeps
 * running on the gateway), the task is still being answered, or the gateway's
 * turn limit is momentarily full.
 */
function isWorthWaitingOut(error: unknown): boolean {
  if (error instanceof GatewayUnreachableError) return true;
  return (
    error instanceof AnswerHttpError &&
    (error.code === "ANSWER_IN_PROGRESS" || error.code === "ANSWER_CAPACITY")
  );
}
