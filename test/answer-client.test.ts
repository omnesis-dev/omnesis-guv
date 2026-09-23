// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import {
  AnswerClient,
  AnswerHttpError,
  GatewayUnreachableError,
  InvalidAnswerResponseError,
  parseAnswerResponse,
  type Fetch,
} from "../src/answer-client.js";

const IDS = { workflowId: "wf_1", conversationId: "conv_1", taskId: "task_1" };

function respond(payload: unknown, status = 200): Fetch {
  return async () => new Response(JSON.stringify(payload), { status });
}

function client(fetchImpl: Fetch, ca?: string): AnswerClient {
  return new AnswerClient({ gatewayUrl: "https://gateway.example.org:7600", token: "omn_test", ca, fetchImpl });
}

const signal = () => new AbortController().signal;

describe("AnswerClient.submit", () => {
  test("posts the question under the request id, never asking for approval", async () => {
    const calls: { url: string; init: Parameters<Fetch>[1] }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ...IDS, status: "released", releaseId: "r", answer: "Hi" }));
    };
    const result = await client(fetchImpl).submit({ question: "Hello?", clientRequestId: "guv_job-1" }, signal());

    expect(result).toEqual({ status: "released", taskId: "task_1", answer: "Hi" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gateway.example.org:7600/answer");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer omn_test");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      question: "Hello?",
      clientRequestId: "guv_job-1",
      approval: "never",
    });
    expect(calls[0]!.init.tls).toBeUndefined();
  });

  test("trusts a configured CA for the gateway's certificate", async () => {
    let tls: { ca: string } | undefined;
    const fetchImpl: Fetch = async (_url, init) => {
      tls = init.tls;
      return new Response(JSON.stringify({ ...IDS, status: "denied", reason: "canceled" }));
    };
    await client(fetchImpl, "-----BEGIN CERTIFICATE-----").submit({ question: "q", clientRequestId: "r" }, signal());
    expect(tls).toEqual({ ca: "-----BEGIN CERTIFICATE-----" });
  });

  test("an error status carries the gateway's code and message", async () => {
    const error = await client(
      respond({ error: "This integration has no access level yet.", code: "ACCESS_LEVEL_REQUIRED" }, 403),
    )
      .submit({ question: "q", clientRequestId: "r" }, signal())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnswerHttpError);
    expect(error).toMatchObject({
      status: 403,
      code: "ACCESS_LEVEL_REQUIRED",
      detail: "This integration has no access level yet.",
    });
  });

  test("an error without a JSON body still reports its status", async () => {
    const fetchImpl: Fetch = async () => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
    const error = await client(fetchImpl).submit({ question: "q", clientRequestId: "r" }, signal()).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: undefined, detail: "Bad Gateway" });
  });

  test("a request that never reaches the gateway is unreachable, naming the address", async () => {
    const fetchImpl: Fetch = async () => {
      throw new TypeError("Unable to connect");
    };
    const error = await client(fetchImpl).submit({ question: "q", clientRequestId: "r" }, signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayUnreachableError);
    expect((error as Error).message).toBe("Cannot reach Omnesis at https://gateway.example.org:7600 (Unable to connect).");
  });

  test("an aborted request rethrows the abort, not an unreachable gateway", async () => {
    const controller = new AbortController();
    const fetchImpl: Fetch = async () => {
      controller.abort(new DOMException("deadline", "TimeoutError"));
      throw new DOMException("aborted", "AbortError");
    };
    const error = await client(fetchImpl).submit({ question: "q", clientRequestId: "r" }, controller.signal).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(GatewayUnreachableError);
    expect((error as DOMException).name).toBe("TimeoutError");
  });
});

describe("parseAnswerResponse", () => {
  test("reads each verdict the gateway can return", () => {
    expect(parseAnswerResponse({ ...IDS, status: "released", releaseId: "r", answer: "A" })).toEqual({
      status: "released",
      taskId: "task_1",
      answer: "A",
    });
    expect(
      parseAnswerResponse({ ...IDS, status: "released_with_reductions", releaseId: "r", answer: "A", reductions: ["names"] }),
    ).toEqual({ status: "released_with_reductions", taskId: "task_1", answer: "A", reductions: ["names"] });
    expect(parseAnswerResponse({ ...IDS, status: "approval_required", approvalId: "ap_1", approvalExpiresAt: 1 })).toEqual({
      status: "approval_required",
      taskId: "task_1",
      approvalId: "ap_1",
    });
    expect(parseAnswerResponse({ ...IDS, status: "denied", reason: "privacy_policy" })).toEqual({
      status: "denied",
      taskId: "task_1",
      reason: "privacy_policy",
    });
  });

  test("never forwards a payload that is not a documented verdict", () => {
    for (const payload of [
      null,
      [],
      "released",
      { ...IDS },
      { ...IDS, status: "maybe" },
      { ...IDS, status: "released" },
      { ...IDS, status: "released", answer: 42 },
      { ...IDS, status: "released_with_reductions", answer: "A" },
      { ...IDS, status: "released_with_reductions", answer: "A", reductions: [1] },
      { ...IDS, status: "approval_required" },
      { ...IDS, status: "denied", reason: "because" },
      { status: "released", answer: "A" },
      { ...IDS, taskId: "", status: "released", answer: "A" },
    ]) {
      expect(() => parseAnswerResponse(payload)).toThrow(InvalidAnswerResponseError);
    }
  });
});
