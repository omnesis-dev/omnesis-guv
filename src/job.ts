// SPDX-License-Identifier: MIT
// One Guv Job, start to finish: check the question, read the token, ask
// Omnesis, and turn whatever happened into the reply the person sees. It never
// throws — a thrown Job fails in Guv without an explanation.

import type { HandlerInput, HandlerResult } from "@familiar/guv-handler-sdk";
import { AnswerClient } from "./answer-client.js";
import { ask, MAX_QUESTION_LENGTH, type AskDeps } from "./ask.js";
import { readToken, type HandlerConfig } from "./config.js";
import { answerReply, errorReply, textReply } from "./reply.js";

export interface JobDeps {
  /** The configuration read at startup, or why it could not be. */
  config: HandlerConfig | Error;
  readToken: (tokenFile: string) => string;
  client: (config: HandlerConfig, token: string) => AskDeps["client"];
  now: AskDeps["now"];
  sleep: AskDeps["sleep"];
}

export const defaultJobDeps = (config: HandlerConfig | Error): JobDeps => ({
  config,
  readToken,
  client: (resolved, token) => new AnswerClient({ gatewayUrl: resolved.gatewayUrl, token, ca: resolved.ca }),
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

export async function answerJob(input: HandlerInput, deps: JobDeps): Promise<HandlerResult> {
  const { config } = deps;
  if (config instanceof Error) return errorReply(config);
  const question = input.input.text.trim();
  if (!question) return textReply("Guv sent an empty question; there was nothing to ask Omnesis.");
  if (question.length > MAX_QUESTION_LENGTH) {
    return textReply(
      `That question is ${question.length.toLocaleString("en")} characters long; ` +
        `Omnesis accepts at most ${MAX_QUESTION_LENGTH.toLocaleString("en")}. Ask it more briefly.`,
    );
  }
  try {
    const client = deps.client(config, deps.readToken(config.tokenFile));
    const response = await ask(question, input.job_id, config.answerTimeoutMs, {
      client,
      now: deps.now,
      sleep: deps.sleep,
    });
    return answerReply(response);
  } catch (error) {
    return errorReply(error, config);
  }
}
