// SPDX-License-Identifier: MIT
// Handler configuration, read once from the environment the Guv daemon passes
// to the handler process. The token itself is not configuration: it lives in a
// file that is read on every Job, so replacing the file rotates the credential
// without restarting Guv.

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export interface HandlerConfig {
  /** Gateway origin (plus any path prefix), without a trailing slash. */
  gatewayUrl: string;
  /** Absolute path of the file holding the integration's token. */
  tokenFile: string;
  /** PEM bundle trusted for the gateway's certificate, when it is not publicly trusted. */
  ca: string | undefined;
  /** How long one Job may spend getting an answer, retries included. */
  answerTimeoutMs: number;
}

/** A configuration problem, worded for the person reading the Guv app. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Leaves room under Guv's default handler timeout (`timeout_ms` 300000 in
 * `handler.config.example.json`): a Job that outlives `timeout_ms` makes Guv
 * restart the handler process, failing every other Job in flight.
 */
export const DEFAULT_ANSWER_TIMEOUT_MS = 240_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function loadConfig(env: Env): HandlerConfig {
  return {
    gatewayUrl: parseGatewayUrl(required(env, "OMNESIS_GATEWAY_URL")),
    tokenFile: absolutePath("OMNESIS_TOKEN_FILE", required(env, "OMNESIS_TOKEN_FILE")),
    ca: readCa(env),
    answerTimeoutMs: parseTimeout(env.OMNESIS_ANSWER_TIMEOUT_MS),
  };
}

/** The integration's token, read fresh for each Job. */
export function readToken(tokenFile: string): string {
  let content: string;
  try {
    content = readFileSync(tokenFile, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read the Omnesis token file ${tokenFile}: ${describe(error)}.`);
  }
  const token = content.trim();
  if (!token) throw new ConfigError(`The Omnesis token file ${tokenFile} is empty.`);
  return token;
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is not set in the Guv daemon's environment.`);
  return value;
}

function absolutePath(name: string, value: string): string {
  // The daemon's environment does no shell expansion, so `~/…` would be read
  // relative to the handler's working directory.
  if (!isAbsolute(value)) throw new ConfigError(`${name} must be an absolute path, got ${value}.`);
  return value;
}

function parseGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`OMNESIS_GATEWAY_URL is not a URL: ${raw}.`);
  }
  // The token travels in every request, so it only crosses a network encrypted.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new ConfigError(`OMNESIS_GATEWAY_URL must use https (plain http only on this machine), got ${raw}.`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new ConfigError(`OMNESIS_GATEWAY_URL must be a plain gateway address, got ${raw}.`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function readCa(env: Env): string | undefined {
  const file = env.OMNESIS_CA_FILE?.trim();
  if (!file) return undefined;
  try {
    return readFileSync(absolutePath("OMNESIS_CA_FILE", file), "utf8");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Cannot read OMNESIS_CA_FILE ${file}: ${describe(error)}.`);
  }
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ANSWER_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`OMNESIS_ANSWER_TIMEOUT_MS must be a positive number of milliseconds, got ${raw}.`);
  }
  return value;
}

function describe(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}
