// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { HANDLER_INPUT_SCHEMA, type HandlerInput, type HandlerResult } from "@familiar/guv-handler-sdk";
import { AnswerHttpError, MAX_QUESTION_LENGTH, type AnswerRequest } from "../src/answer-client.js";
import { ConfigError, TokenFileError, type HandlerConfig } from "../src/config.js";
import { answerJob, type JobDeps } from "../src/job.js";

const CONFIG: HandlerConfig = {
  gatewayUrl: "https://gateway.example.org:7600",
  tokenFile: "/secure/guv.token",
  ca: undefined,
  answerTimeoutMs: 60_000,
};

function input(text: string): HandlerInput {
  return { schema: HANDLER_INPUT_SCHEMA, job_id: "job-42", run_id: "run-1", input: { text } };
}

function summaryOf(result: HandlerResult): string {
  if (result.kind !== "outcome_produced") throw new Error("expected an outcome");
  return result.outcome.summary;
}

function deps(overrides: Partial<JobDeps> = {}) {
  const seen: { token?: string; requests: AnswerRequest[] } = { requests: [] };
  let clock = 0;
  const value: JobDeps = {
    config: CONFIG,
    readToken: () => "omn_live",
    makeClient: (_config, token) => {
      seen.token = token;
      return {
        submit: async (request) => {
          seen.requests.push(request);
          return { status: "released", taskId: "task_1", answer: "It is sunny." };
        },
      };
    },
    // An advancing clock, so a scripted retry can never spin forever.
    clock: {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      timeout: () => new AbortController().signal,
    },
    ...overrides,
  };
  return { value, seen };
}

describe("answerJob", () => {
  test("asks the Job's question with the token read for this Job", async () => {
    const { value, seen } = deps();
    expect(summaryOf(await answerJob(input("  Weather today?  "), value))).toBe("It is sunny.");
    expect(seen.token).toBe("omn_live");
    expect(seen.requests).toEqual([{ question: "Weather today?", clientRequestId: "guv_job-42" }]);
  });

  test("reports a configuration read at startup that failed, without asking", async () => {
    const { value, seen } = deps({ config: new ConfigError("--gateway-url is missing from the handler's command.") });
    expect(summaryOf(await answerJob(input("Weather?"), value))).toContain("--gateway-url is missing");
    expect(seen.requests).toEqual([]);
  });

  test("reports a token file it cannot use, without asking", async () => {
    const { value, seen } = deps({
      readToken: () => {
        throw new TokenFileError("The Omnesis token file /secure/guv.token is empty.");
      },
    });
    expect(summaryOf(await answerJob(input("Weather?"), value))).toContain("/secure/guv.token is empty");
    expect(seen.requests).toEqual([]);
  });

  test("answers an empty or overlong question itself, and passes one at the limit", async () => {
    const { value, seen } = deps();
    expect(summaryOf(await answerJob(input(" \n "), value))).toContain("empty question");
    expect(summaryOf(await answerJob(input("x".repeat(MAX_QUESTION_LENGTH + 1)), value))).toContain(
      `at most ${MAX_QUESTION_LENGTH.toLocaleString("en")}`,
    );
    expect(seen.requests).toEqual([]);
    expect(summaryOf(await answerJob(input("x".repeat(MAX_QUESTION_LENGTH)), value))).toBe("It is sunny.");
  });

  test("turns a gateway refusal into its reply, with the configured token file", async () => {
    const { value } = deps({
      makeClient: () => ({
        submit: async () => {
          throw new AnswerHttpError(401, "UNAUTHORIZED", "Unauthorized");
        },
      }),
    });
    const summary = summaryOf(await answerJob(input("Weather?"), value));
    expect(summary).toContain("rejected this handler's token");
    expect(summary).toContain("/secure/guv.token");
  });
});
