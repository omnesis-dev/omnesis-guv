// SPDX-License-Identifier: MIT
// One call to the Omnesis gateway's `POST /answer`: send a question, get back
// the gateway's verdict. The gateway keeps each request id as one durable task
// and never delivers two answers for it, which is what lets `ask.ts` post the
// same request again after a failure.

/** The gateway's `/answer` question limit, in UTF-16 code units. */
export const MAX_QUESTION_LENGTH = 10_000;

/** The gateway's verdict on one question. */
export type AnswerResponse =
  | { status: "released"; taskId: string; answer: string }
  | { status: "released_with_reductions"; taskId: string; answer: string; reductions: string[] }
  | { status: "approval_required"; taskId: string; approvalId: string }
  /** `reason` is deliberately coarse — findings never cross the boundary — and may gain values. */
  | { status: "denied"; taskId: string; reason: string };

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

/**
 * The request, or its response, never made it across the network. The
 * message names only the failure's code: a raw fetch message can quote the
 * request, token included.
 */
export class GatewayUnreachableError extends Error {
  override readonly name = "GatewayUnreachableError";
  constructor(gatewayUrl: string, code: string | undefined) {
    super(`Cannot reach Omnesis at ${gatewayUrl}${code ? ` (${code})` : ""}.`);
  }
}

/** The gateway's certificate is not trusted; retrying cannot help. */
export class GatewayCertificateError extends Error {
  override readonly name = "GatewayCertificateError";
  constructor(readonly code: string) {
    super(`The Omnesis gateway's certificate is not trusted (${code}).`);
  }
}

/**
 * The gateway address answers with a redirect, which is never followed with
 * the token. Only the target's origin is quoted: the reply leaves this machine.
 */
export class GatewayRedirectError extends Error {
  override readonly name = "GatewayRedirectError";
  constructor(targetOrigin: string | undefined) {
    super(`The Omnesis gateway address redirects${targetOrigin ? ` to ${targetOrigin}` : ""}.`);
  }
}

/** A success response that does not have the documented shape is never forwarded. */
export class InvalidAnswerResponseError extends Error {
  override readonly name = "InvalidAnswerResponseError";
  constructor() {
    super("Omnesis answered in a form this handler does not understand.");
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

/** Certificate failures as Bun's `fetch` reports them. */
const CERTIFICATE_ERRORS: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export class AnswerClient {
  private readonly fetchImpl: Fetch;

  constructor(private readonly options: AnswerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(request: AnswerRequest, signal: AbortSignal): Promise<AnswerResponse> {
    let response: Response;
    let body: string;
    try {
      response = await this.fetchImpl(`${this.options.gatewayUrl}/answer`, {
        method: "POST",
        signal,
        // `/answer` never redirects; following one would send the token on.
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.token}`,
        },
        // A Guv Job has nobody to approve a held answer, so the gateway
        // never holds one for approval.
        body: JSON.stringify({ ...request, approval: "never" }),
        ...(this.options.ca ? { tls: { ca: this.options.ca } } : {}),
      });
      // Read inside the transport guard: a connection lost mid-body is a
      // dropped connection like any other.
      body = await response.text();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const code = errorCode(error);
      if (code && CERTIFICATE_ERRORS.has(code)) throw new GatewayCertificateError(code);
      throw new GatewayUnreachableError(this.options.gatewayUrl, code);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new GatewayRedirectError(originOf(response.headers.get("location"), this.options.gatewayUrl));
    }
    const payload = parseJson(body);
    if (!response.ok) {
      const envelope = isRecord(payload) ? payload : {};
      throw new AnswerHttpError(
        response.status,
        typeof envelope.code === "string" ? envelope.code : undefined,
        typeof envelope.error === "string" && envelope.error.trim()
          ? envelope.error.trim()
          : response.statusText || "no detail given",
      );
    }
    return parseAnswerResponse(payload);
  }
}

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
      if (typeof payload.reason !== "string") break;
      return { status, taskId, reason: payload.reason };
  }
  throw new InvalidAnswerResponseError();
}

function originOf(location: string | null, base: string): string | undefined {
  if (!location) return undefined;
  try {
    return new URL(location, base).origin;
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A fetch failure's code, from the error or the cause it wraps. */
function errorCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 3; depth++) {
    if (typeof current !== "object") return undefined;
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
