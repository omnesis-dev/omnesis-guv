// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import {
  AnswerClient,
  AnswerHttpError,
  InvalidAnswerResponseError,
} from "../src/answer-client.js";

const BASE = {
  status: "released",
  answer: "hello",
  workflowId: "wf",
  conversationId: "conv",
  taskId: "task",
};

function stubFetch(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

describe("AnswerClient", () => {
  test("submit posts question with bearer auth and parses the response", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: unknown, init: unknown) => {
      seenUrl = String(url);
      seenAuth = (init as RequestInit).headers
        ? ((init as RequestInit).headers as Record<string, string>).Authorization
        : "";
      return new Response(JSON.stringify(BASE), { status: 200 });
    }) as typeof fetch;
    const client = new AnswerClient({ baseUrl: "https://gw:7600/", token: "tok", fetchImpl });
    const result = await client.submit({ question: "q?", clientRequestId: "id-1" });
    expect(seenUrl).toBe("https://gw:7600/answer");
    expect(seenAuth).toBe("Bearer tok");
    expect(result.status).toBe("released");
    expect(result.taskId).toBe("task");
  });

  test("getTask hits the task route", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: unknown) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ ...BASE, status: "denied", reason: "no" }), {
        status: 200,
      });
    }) as typeof fetch;
    const client = new AnswerClient({ baseUrl: "https://gw:7600", token: "tok", fetchImpl });
    const result = await client.getTask("abc");
    expect(seenUrl).toBe("https://gw:7600/answer/tasks/abc");
    expect(result.status).toBe("denied");
  });

  test("HTTP errors become AnswerHttpError with gateway detail", async () => {
    const client = new AnswerClient({
      baseUrl: "https://gw:7600",
      token: "tok",
      fetchImpl: stubFetch({ error: "answer scope required" }, 403),
    });
    const error = await client.submit({ question: "q", clientRequestId: "id" }).catch((e) => e);
    expect(error).toBeInstanceOf(AnswerHttpError);
    expect((error as AnswerHttpError).status).toBe(403);
    expect((error as AnswerHttpError).message).toContain("answer scope required");
  });

  test("malformed payloads are rejected, never forwarded", async () => {
    for (const payload of [null, {}, { status: "maybe" }, { ...BASE, taskId: 42 }]) {
      const client = new AnswerClient({
        baseUrl: "https://gw:7600",
        token: "tok",
        fetchImpl: stubFetch(payload),
      });
      const error = await client.submit({ question: "q", clientRequestId: "id" }).catch((e) => e);
      expect(error).toBeInstanceOf(InvalidAnswerResponseError);
    }
  });

  test("unreachable gateway is a plain error naming the URL", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const client = new AnswerClient({ baseUrl: "https://gw:7600", token: "tok", fetchImpl });
    const error = await client.submit({ question: "q", clientRequestId: "id" }).catch((e) => e);
    expect(String((error as Error).message)).toContain("https://gw:7600");
  });
});
