// SPDX-License-Identifier: MIT
// Handler configuration, read once at startup from the command line Guv starts
// the handler with — the `command` in the handler configuration loaded with
// `guv handler load`, so the whole setup lives in that one file. The token and
// the CA bundle are not read then: they live in files read on every Job, so
// replacing either (a rotated token, a renewed certificate) takes effect
// without restarting Guv.

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";

export interface HandlerConfig {
  /** Gateway origin (plus any path prefix), without a trailing slash. */
  gatewayUrl: string;
  /** Absolute path of the file holding the integration's token. */
  tokenFile: string;
  /** Absolute path of a PEM bundle trusted for the gateway's certificate, when it is not publicly trusted. */
  caFile: string | undefined;
  /** How long one Job may spend getting an answer, retries included. */
  answerTimeoutMs: number;
}

/** The handler's command line is wrong; fixing it means reloading the handler into Guv. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** A file read for each Job (the token, the CA bundle) cannot be used; the next Job reads it again. */
export class JobFileError extends Error {
  override readonly name = "JobFileError";
}

/**
 * 60 seconds under the `timeout_ms` of 300000 in handler.config.example.json:
 * a Job that outlives `timeout_ms` makes Guv restart the handler process,
 * failing every other Job in flight.
 */
export const DEFAULT_ANSWER_TIMEOUT_MS = 240_000;

/** Guv's own ceiling for a handler's `timeout_ms`; a Job cannot be given longer. */
const MAX_ANSWER_TIMEOUT_MS = 86_400_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function loadConfig(argv: readonly string[]): HandlerConfig {
  const options = parseOptions(argv);
  return {
    gatewayUrl: parseGatewayUrl(required(options["gateway-url"], "--gateway-url")),
    tokenFile: absolutePath(required(options["token-file"], "--token-file"), "--token-file"),
    caFile: options["ca-file"] === undefined ? undefined : absolutePath(options["ca-file"], "--ca-file"),
    answerTimeoutMs: parseTimeout(options["answer-timeout-ms"]),
  };
}

/** What each Job reads from disk: the token, and the CA bundle when one is configured. */
export interface JobFiles {
  token: string;
  ca: string | undefined;
}

export function readJobFiles(config: Pick<HandlerConfig, "tokenFile" | "caFile">): JobFiles {
  return { token: readToken(config.tokenFile), ca: config.caFile === undefined ? undefined : readCa(config.caFile) };
}

/** The integration's token, read fresh for each Job. */
export function readToken(tokenFile: string): string {
  let content: string;
  try {
    content = readFileSync(tokenFile, "utf8");
  } catch (error) {
    throw new JobFileError(`Cannot read the Omnesis token file ${tokenFile}: ${describe(error)}.`);
  }
  const token = content.trim();
  if (!token) throw new JobFileError(`The Omnesis token file ${tokenFile} is empty.`);
  // A token is one printable word. Anything else (a whole JSON response, two
  // lines) would be refused by fetch with an error that quotes the header, so
  // it is refused here, without repeating the file's content.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new JobFileError(`The Omnesis token file ${tokenFile} does not hold a single token.`);
  }
  return token;
}

/** The CA bundle, read fresh for each Job; each certificate in it must parse. */
export function readCa(caFile: string): string {
  let pem: string;
  try {
    pem = readFileSync(caFile, "utf8");
  } catch (error) {
    throw new JobFileError(`Cannot read the CA bundle ${caFile}: ${describe(error)}.`);
  }
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (certificates.length === 0) throw new JobFileError(`The CA bundle ${caFile} holds no PEM certificate.`);
  for (const certificate of certificates) {
    try {
      new X509Certificate(certificate);
    } catch {
      throw new JobFileError(`The CA bundle ${caFile} holds a certificate that cannot be parsed.`);
    }
  }
  return pem;
}

function parseOptions(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        "gateway-url": { type: "string" },
        "token-file": { type: "string" },
        "ca-file": { type: "string" },
        "answer-timeout-ms": { type: "string" },
      },
    }).values;
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
}

function required(value: string | undefined, flag: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new ConfigError(`${flag} is missing from the handler's command.`);
  return trimmed;
}

function absolutePath(value: string, flag: string): string {
  // Guv runs the command without a shell, so nothing expands `~/…`.
  if (!isAbsolute(value)) throw new ConfigError(`${flag} must be an absolute path, got ${value}.`);
  return value;
}

function parseGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("--gateway-url is not a URL.");
  }
  // Quoted without any credentials it carries: the reply travels through Guv's service.
  const shown = `${url.protocol}//${url.host}${url.pathname}`;
  // The token travels in every request, so it only crosses a network encrypted.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new ConfigError(`--gateway-url must use https (plain http only on this machine), got ${shown}.`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new ConfigError(`--gateway-url must be a plain gateway address, without credentials, a query or a fragment.`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ANSWER_TIMEOUT_MS;
  const value = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(value) || value <= 0 || value > MAX_ANSWER_TIMEOUT_MS) {
    throw new ConfigError(
      `--answer-timeout-ms must be a whole number of milliseconds from 1 to ${MAX_ANSWER_TIMEOUT_MS}, got ${raw}.`,
    );
  }
  return value;
}

const FILE_ERRORS: Record<string, string> = {
  ENOENT: "no such file",
  EACCES: "permission denied",
  EISDIR: "it is a directory",
};

function describe(error: unknown): string {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code) return FILE_ERRORS[code] ?? code;
  return error instanceof Error ? error.message : String(error);
}
