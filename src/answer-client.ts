// SPDX-License-Identifier: MIT
// Minimal typed HTTPS client for the Omnesis privacy-brokered `/answer`
// boundary. It mirrors the contract of `@omnesis/gateway-client`'s
// `AnswerHttpClient` (POST /answer, GET /answer/tasks/:id, Bearer auth)
// without depending on the Omnesis monorepo, which is not published to a
// package registry. Any behavioral drift from the gateway's answer boundary
// should be fixed here and covered by `test/answer-client.test.ts`.

export type AnswerStatus =
  | "released"
  | "released_with_reductions"
  | "approval_required"
  | "denied";

export interface AnswerResponse {
  status: AnswerStatus;
  answer?: string;
  reductions?: string[];
  reason?: string | null;
  approvalId?: string | null;
  workflowId: string;
  conversationId: string;
  taskId: string;
}

export interface SubmitAnswerInput {
  question: string;
  clientRequestId: string;
  conversationId?: string;
  workflowId?: string;
  workflowName?: string;
  workflowPurpose?: string;
  /** Non-interactive default: never hold for approval. */
  approval?: "allow" | "never";
}

export interface AnswerRequestOptions {
  signal?: AbortSignal;
}

export interface AnswerClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** A typed HTTP failure from the public Answer boundary. */
export class AnswerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Omnesis answer request failed (HTTP ${status}): ${detail}`);
    this.name = "AnswerHttpError";
  }
}

/** A malformed success payload is never safe to forward. */
export class InvalidAnswerResponseError extends Error {
  constructor() {
    super("Gateway returned a malformed Answer response.");
    this.name = "InvalidAnswerResponseError";
  }
}

const STATUSES: ReadonlySet<string> = new Set([
  "released",
  "released_with_reductions",
  "approval_required",
  "denied",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseAnswerResponse(payload: unknown): AnswerResponse {
  if (!isRecord(payload)) throw new InvalidAnswerResponseError();
  const { status } = payload;
  if (typeof status !== "string" || !STATUSES.has(status)) {
    throw new InvalidAnswerResponseError();
  }
  const workflowId = optionalString(payload.workflowId);
  const conversationId = optionalString(payload.conversationId);
  const taskId = optionalString(payload.taskId);
  if (!workflowId || !conversationId || !taskId) {
    throw new InvalidAnswerResponseError();
  }
  let reductions: string[] | undefined;
  if (payload.reductions !== undefined) {
    if (!Array.isArray(payload.reductions) || !payload.reductions.every((r) => typeof r === "string")) {
      throw new InvalidAnswerResponseError();
    }
    reductions = payload.reductions as string[];
  }
  const reason =
    payload.reason === null || payload.reason === undefined
      ? undefined
      : optionalString(payload.reason) ?? undefined;
  const approvalId =
    payload.approvalId === null || payload.approvalId === undefined
      ? undefined
      : optionalString(payload.approvalId) ?? undefined;
  return {
    status: status as AnswerStatus,
    answer: optionalString(payload.answer),
    reductions,
    reason,
    approvalId,
    workflowId,
    conversationId,
    taskId,
  };
}

/**
 * Minimal, cancellation-aware client for the gateway's `/answer` boundary.
 * It deliberately stays thin: no retries (the caller owns cancellation and
 * idempotency via `clientRequestId`), one request per call.
 */
export class AnswerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnswerClientOptions) {
    if (!options.token) throw new Error("AnswerClient requires a token.");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(
    input: SubmitAnswerInput,
    options: AnswerRequestOptions = {},
  ): Promise<AnswerResponse> {
    if (!input.question.trim()) throw new Error("submit requires a non-empty question.");
    if (!input.clientRequestId.trim()) throw new Error("submit requires a clientRequestId.");
    return this.request("/answer", {
      method: "POST",
      signal: options.signal,
      body: JSON.stringify({
        question: input.question,
        clientRequestId: input.clientRequestId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(input.workflowName ? { workflowName: input.workflowName } : {}),
        ...(input.workflowPurpose ? { workflowPurpose: input.workflowPurpose } : {}),
        approval: input.approval ?? "never",
      }),
    });
  }

  async getTask(taskId: string, options: AnswerRequestOptions = {}): Promise<AnswerResponse> {
    if (!taskId.trim()) throw new Error("getTask requires a task id.");
    return this.request(`/answer/tasks/${encodeURIComponent(taskId)}`, {
      signal: options.signal,
    });
  }

  private async request(path: string, init: RequestInit): Promise<AnswerResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "omnesis-guv-handler",
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(
        `Cannot reach the Omnesis gateway at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : isRecord(payload) && typeof payload.message === "string"
            ? payload.message
            : response.statusText || "request failed";
      throw new AnswerHttpError(response.status, detail);
    }
    return parseAnswerResponse(payload);
  }
}
