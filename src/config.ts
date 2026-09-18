// SPDX-License-Identifier: MIT
// Runtime configuration for the handler. Everything comes from the
// environment so no secret is ever committed; the token is loaded lazily on
// every Job so rotation never needs a daemon restart.

import { readFileSync } from "node:fs";

export type Env = Record<string, string | undefined>;

export interface HandlerConfig {
  gatewayUrl: string;
  /** Resolved token, or null when neither source is set. */
  token: string | null;
  /** Per-answer-call budget in ms. Must fit inside the handler timeout. */
  answerTimeoutMs: number;
}

export const DEFAULT_ANSWER_TIMEOUT_MS = 240_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, got: ${raw}`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): HandlerConfig {
  // Loopback gateways commonly use self-signed certificates. TLS
  // verification stays ON unless this is explicitly set to "1" — and even
  // then only use it for loopback gateways, never across a network.
  if (env.OMNESIS_INSECURE_TLS === "1") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const gatewayUrl = (env.OMNESIS_GATEWAY_URL ?? "https://localhost:7600").replace(/\/+$/, "");
  return {
    gatewayUrl,
    token: resolveToken(env),
    answerTimeoutMs: parsePositiveInt(env.OMNESIS_ANSWER_TIMEOUT_MS, DEFAULT_ANSWER_TIMEOUT_MS),
  };
}

/** Mirrors the CLI's precedence: explicit env token first, token file second. */
export function resolveToken(env: Env = process.env): string | null {
  const direct = env.OMNESIS_TOKEN?.trim();
  if (direct) return direct;
  const file = env.OMNESIS_TOKEN_FILE?.trim();
  if (!file) return null;
  try {
    const content = readFileSync(file, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}
