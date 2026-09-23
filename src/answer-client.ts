// SPDX-License-Identifier: MIT
// One call to the Omnesis gateway's `POST /answer`: send a question, get back
// the gateway's verdict. The gateway makes each request id a durable task, so
// posting the same id again attaches to that task instead of asking twice;
// `ask.ts` relies on that to retry safely.

/** Why the gateway declined to release an answer. Deliberately coarse: findings never cross the boundary. */
export type DenialReason =
  | "privacy_policy"
  | "hard_stop"
  | "user_denied"
  | "expired"
  | "canceled"
  | "approval_not_available";

/** The gateway's verdict on one question. */
export type AnswerResponse =
  | { status: "released"; taskId: string; answer: string }
  | { status: "released_with_reductions"; taskId: string; answer: string; reductions: string[] }
  | { status: "approval_required"; taskId: string; approvalId: string }
  | { status: "denied"; taskId: string; reason: DenialReason };

export interface AnswerRequest {
  question: string;
  clientRequestId: string;
}

/** The gateway answered with an error status; `code` is its machine-readable error code. */
export class AnswerHttpError extends Error {
  override readonly name = "AnswerHttpError";
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly detail: string,
  ) {
    super(`Omnesis answered HTTP ${status}${code ? ` ${code}` : ""}: ${detail}`);
  }
}

/** The request never produced an HTTP response. */
export class GatewayUnreachableError extends Error {
  override readonly name = "GatewayUnreachableError";
}

/** A success response that does not have the documented shape is never forwarded. */
export class InvalidAnswerResponseError extends Error {
  override readonly name = "InvalidAnswerResponseError";
  constructor() {
    super("Omnesis sent an answer in a shape this handler does not understand.");
  }
}

/** The slice of `fetch` the client uses; Bun's `fetch` takes `tls` for a private CA. */
export type Fetch = (url: string, init: RequestInit & { tls?: { ca: string } }) => Promise<Response>;

export interface AnswerClientOptions {
  gatewayUrl: string;
  token: string;
  /** PEM bundle to trust for the gateway's certificate. */
  ca?: string | undefined;
  fetchImpl?: Fetch;
}

export class AnswerClient {
  private readonly fetchImpl: Fetch;

  constructor(private readonly options: AnswerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(request: AnswerRequest, signal: AbortSignal): Promise<AnswerResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.gatewayUrl}/answer`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.token}`,
        },
        // A Guv Job has nobody to approve a held answer, so the gateway
        // never holds one for approval.
        body: JSON.stringify({ ...request, approval: "never" }),
        ...(this.options.ca ? { tls: { ca: this.options.ca } } : {}),
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new GatewayUnreachableError(
        `Cannot reach Omnesis at ${this.options.gatewayUrl} (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const envelope = isRecord(payload) ? payload : {};
      throw new AnswerHttpError(
        response.status,
        typeof envelope.code === "string" ? envelope.code : undefined,
        typeof envelope.error === "string" ? envelope.error : response.statusText || "no detail given",
      );
    }
    return parseAnswerResponse(payload);
  }
}

const DENIAL_REASONS: ReadonlySet<string> = new Set<DenialReason>([
  "privacy_policy",
  "hard_stop",
  "user_denied",
  "expired",
  "canceled",
  "approval_not_available",
]);

export function parseAnswerResponse(payload: unknown): AnswerResponse {
  if (!isRecord(payload)) throw new InvalidAnswerResponseError();
  const { status, taskId } = payload;
  if (typeof taskId !== "string" || !taskId) throw new InvalidAnswerResponseError();
  switch (status) {
    case "released":
      if (typeof payload.answer !== "string") break;
      return { status, taskId, answer: payload.answer };
    case "released_with_reductions":
      if (typeof payload.answer !== "string" || !isStringArray(payload.reductions)) break;
      return { status, taskId, answer: payload.answer, reductions: payload.reductions };
    case "approval_required":
      if (typeof payload.approvalId !== "string" || !payload.approvalId) break;
      return { status, taskId, approvalId: payload.approvalId };
    case "denied":
      if (typeof payload.reason !== "string" || !DENIAL_REASONS.has(payload.reason)) break;
      return { status, taskId, reason: payload.reason as DenialReason };
  }
  throw new InvalidAnswerResponseError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
