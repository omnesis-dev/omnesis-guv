// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import type { HandlerInput, HandlerResult } from "@familiar/guv-handler-sdk";
import { AnswerHttpError, type AnswerRequest } from "../src/answer-client.js";
import { ConfigError, type HandlerConfig } from "../src/config.js";
import { answerJob, type JobDeps } from "../src/job.js";

const CONFIG: HandlerConfig = {
  gatewayUrl: "https://gateway.example.org:7600",
  tokenFile: "/secure/guv.token",
  ca: undefined,
  answerTimeoutMs: 60_000,
};

function input(text: string): HandlerInput {
  return { schema: "com.familiar.handler.input.v1", job_id: "job-42", run_id: "run-1", input: { text } };
}

function summaryOf(result: HandlerResult): string {
  if (result.kind !== "outcome_produced") throw new Error("expected an outcome");
  return result.outcome.summary;
}

function deps(overrides: Partial<JobDeps> = {}) {
  const seen: { token?: string; requests: AnswerRequest[] } = { requests: [] };
  const value: JobDeps = {
    config: CONFIG,
    readToken: () => "omn_live",
    client: (_config, token) => {
      seen.token = token;
      return {
        submit: async (request) => {
          seen.requests.push(request);
          return { status: "released", taskId: "task_1", answer: "It is sunny." };
        },
      };
    },
    now: () => 0,
    sleep: async () => {},
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

  test("reports a configuration read at startup that failed", async () => {
    const { value, seen } = deps({ config: new ConfigError("OMNESIS_GATEWAY_URL is not set in the Guv daemon's environment.") });
    expect(summaryOf(await answerJob(input("Weather?"), value))).toContain("OMNESIS_GATEWAY_URL is not set");
    expect(seen.requests).toEqual([]);
  });

  test("reports a token file it cannot read, without asking", async () => {
    const { value, seen } = deps({
      readToken: () => {
        throw new ConfigError("The Omnesis token file /secure/guv.token is empty.");
      },
    });
    expect(summaryOf(await answerJob(input("Weather?"), value))).toContain("/secure/guv.token is empty");
    expect(seen.requests).toEqual([]);
  });

  test("answers an empty or overlong question itself", async () => {
    const { value, seen } = deps();
    expect(summaryOf(await answerJob(input(" \n "), value))).toContain("empty question");
    expect(summaryOf(await answerJob(input("x".repeat(10_001)), value))).toContain("at most 10,000");
    expect(seen.requests).toEqual([]);
  });

  test("turns a gateway refusal into its reply", async () => {
    const { value } = deps({
      client: () => ({
        submit: async () => {
          throw new AnswerHttpError(401, "UNAUTHORIZED", "Unauthorized");
        },
      }),
    });
    expect(summaryOf(await answerJob(input("Weather?"), value))).toContain("rejected this handler's token");
  });
});
