// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import {
  AnswerClient,
  AnswerHttpError,
  GatewayCertificateError,
  GatewayRedirectError,
  GatewayUnreachableError,
  InvalidAnswerResponseError,
  parseAnswerResponse,
  type Fetch,
} from "../src/answer-client.js";

const GATEWAY = "https://gateway.example.org:7600";
const IDS = { workflowId: "wf_1", conversationId: "conv_1", taskId: "task_1" };

function respond(body: unknown, init: ResponseInit = {}): Fetch {
  return async () => new Response(typeof body === "string" ? body : JSON.stringify(body), init);
}

function client(fetchImpl: Fetch, ca?: string): AnswerClient {
  return new AnswerClient({ gatewayUrl: GATEWAY, token: "omn_secret", ca, fetchImpl });
}

const REQUEST = { question: "q", clientRequestId: "guv_job-1" };
const signal = () => new AbortController().signal;
const failure = (fetchImpl: Fetch, abort = signal()) =>
  client(fetchImpl)
    .submit(REQUEST, abort)
    .catch((e: unknown) => e);

describe("AnswerClient.submit", () => {
  test("posts the question under the request id, never asking for approval or following redirects", async () => {
    const calls: { url: string; init: Parameters<Fetch>[1] }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ...IDS, status: "released", releaseId: "r", answer: "Hi" }));
    };
    const abort = signal();
    const result = await client(fetchImpl).submit({ question: "Hello?", clientRequestId: "guv_job-1" }, abort);

    expect(result).toEqual({ status: "released", taskId: "task_1", answer: "Hi" });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [(typeof calls)[number]];
    expect(url).toBe(`${GATEWAY}/answer`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    // The Job's time budget reaches the request itself.
    expect(init.signal).toBe(abort);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer omn_secret");
    expect(JSON.parse(init.body as string)).toEqual({
      question: "Hello?",
      clientRequestId: "guv_job-1",
      approval: "never",
    });
    expect(init.tls).toBeUndefined();
  });

  test("trusts a configured CA for the gateway's certificate", async () => {
    let tls: { ca: string } | undefined;
    const fetchImpl: Fetch = async (_url, init) => {
      tls = init.tls;
      return new Response(JSON.stringify({ ...IDS, status: "denied", reason: "canceled" }));
    };
    await client(fetchImpl, "-----BEGIN CERTIFICATE-----").submit(REQUEST, signal());
    expect(tls).toEqual({ ca: "-----BEGIN CERTIFICATE-----" });
  });

  test("an error status carries the gateway's code and message", async () => {
    const error = await failure(
      respond({ error: "This integration has no access level yet.", code: "ACCESS_LEVEL_REQUIRED" }, { status: 403 }),
    );
    expect(error).toBeInstanceOf(AnswerHttpError);
    expect(error).toMatchObject({
      status: 403,
      code: "ACCESS_LEVEL_REQUIRED",
      detail: "This integration has no access level yet.",
    });
  });

  test("an error without a JSON body still reports its status", async () => {
    const error = await failure(respond("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    expect(error).toMatchObject({ status: 502, code: undefined, detail: "Bad Gateway" });
  });

  test("a redirect is refused, not followed", async () => {
    const error = await failure(
      respond("", { status: 308, headers: { location: "http://elsewhere.example.org/answer" } }),
    );
    expect(error).toBeInstanceOf(GatewayRedirectError);
    expect((error as Error).message).toBe(
      "The Omnesis gateway address redirects to http://elsewhere.example.org/answer.",
    );
  });

  test("a network failure is unreachable, naming the address and the code but never the request", async () => {
    const error = await failure(async () => {
      throw Object.assign(new TypeError("Header 'Authorization' has invalid value: 'Bearer omn_secret'"), {
        code: "ERR_INVALID_HTTP_TOKEN",
      });
    });
    expect(error).toBeInstanceOf(GatewayUnreachableError);
    expect((error as Error).message).toBe(`Cannot reach Omnesis at ${GATEWAY} (ERR_INVALID_HTTP_TOKEN).`);
  });

  test("an untrusted certificate is its own failure", async () => {
    const error = await failure(async () => {
      throw Object.assign(new TypeError("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    });
    expect(error).toBeInstanceOf(GatewayCertificateError);
    expect(error).toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  });

  test("a connection lost while reading the answer is a dropped connection", async () => {
    const error = await failure(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(Object.assign(new Error("socket closed"), { code: "ECONNRESET" }));
        },
      });
      return new Response(body, { status: 200 });
    });
    expect(error).toBeInstanceOf(GatewayUnreachableError);
  });

  test("an aborted request rethrows the abort, not an unreachable gateway", async () => {
    const controller = new AbortController();
    const error = await failure(async () => {
      controller.abort(new DOMException("deadline", "TimeoutError"));
      throw new DOMException("aborted", "AbortError");
    }, controller.signal);
    expect(error).not.toBeInstanceOf(GatewayUnreachableError);
    expect((error as DOMException).name).toBe("TimeoutError");
  });

  test("a success response that is not JSON is never forwarded", async () => {
    expect(await failure(respond("<html>a login page</html>", { status: 200 }))).toBeInstanceOf(
      InvalidAnswerResponseError,
    );
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
      parseAnswerResponse({
        ...IDS,
        status: "released_with_reductions",
        releaseId: "r",
        answer: "A",
        reductions: ["Names"],
      }),
    ).toEqual({ status: "released_with_reductions", taskId: "task_1", answer: "A", reductions: ["Names"] });
    expect(
      parseAnswerResponse({ ...IDS, status: "approval_required", approvalId: "ap_1", approvalExpiresAt: 1 }),
    ).toEqual({
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

  test("keeps a denial reason it does not know, so a newer gateway still reads as a denial", () => {
    expect(parseAnswerResponse({ ...IDS, status: "denied", reason: "new_reason" })).toMatchObject({
      reason: "new_reason",
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
      { ...IDS, status: "denied" },
      { status: "released", answer: "A" },
      { ...IDS, taskId: "", status: "released", answer: "A" },
    ]) {
      expect(() => parseAnswerResponse(payload)).toThrow(InvalidAnswerResponseError);
    }
  });
});
