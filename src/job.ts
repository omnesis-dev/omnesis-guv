// SPDX-License-Identifier: MIT
// One Guv Job, start to finish: check the question, read its files, ask
// Omnesis, and turn whatever happened into the reply the person sees. It never
// throws: a thrown Job makes the handler process exit, failing every Job in
// flight without an explanation.

import type { HandlerInput, HandlerResult } from "@familiar/guv-handler-sdk";
import { AnswerClient, MAX_QUESTION_LENGTH } from "./answer-client.js";
import { ask, type AskDeps } from "./ask.js";
import { readJobFiles, type ConfigError, type HandlerConfig, type JobFiles } from "./config.js";
import { answerReply, configErrorReply, errorReply, textReply } from "./reply.js";

export interface JobDeps {
  /** The configuration read at startup, or why it could not be. */
  config: HandlerConfig | ConfigError;
  readFiles: (config: HandlerConfig) => JobFiles;
  makeClient: (config: HandlerConfig, files: JobFiles) => AskDeps["client"];
  clock: Pick<AskDeps, "now" | "sleep" | "timeout">;
}

export function productionJobDeps(config: HandlerConfig | ConfigError): JobDeps {
  return {
    config,
    readFiles: readJobFiles,
    makeClient: (resolved, files) => new AnswerClient({ gatewayUrl: resolved.gatewayUrl, ...files }),
    clock: {
      // Monotonic, so a wall-clock step cannot stretch a Job past its budget.
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      timeout: (ms) => AbortSignal.timeout(ms),
    },
  };
}

export async function answerJob(input: HandlerInput, deps: JobDeps): Promise<HandlerResult> {
  const { config } = deps;
  if (config instanceof Error) return configErrorReply(config);
  const question = input.input.text.trim();
  if (!question) return textReply("Guv sent an empty question; there was nothing to ask Omnesis.");
  if (question.length > MAX_QUESTION_LENGTH) {
    return textReply(
      `That question is ${question.length.toLocaleString("en")} characters long; ` +
        `Omnesis accepts at most ${MAX_QUESTION_LENGTH.toLocaleString("en")}. Ask it more briefly.`,
    );
  }
  try {
    const client = deps.makeClient(config, deps.readFiles(config));
    return answerReply(await ask(question, input.job_id, config.answerTimeoutMs, { client, ...deps.clock }));
  } catch (error) {
    return errorReply(error, config);
  }
}
