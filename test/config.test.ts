// SPDX-License-Identifier: MIT
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  DEFAULT_ANSWER_TIMEOUT_MS,
  JobFileError,
  loadConfig,
  readCa,
  readJobFiles,
  readToken,
} from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "omnesis-guv-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN_FILE = join(dir, "guv.token");
const GATEWAY = "https://gateway.example.org:7600";

function args(overrides: Record<string, string | undefined> = {}): string[] {
  const flags: Record<string, string | undefined> = { "gateway-url": GATEWAY, "token-file": TOKEN_FILE, ...overrides };
  return Object.entries(flags).flatMap(([flag, value]) => (value === undefined ? [] : [`--${flag}`, value]));
}

function configError(argv: string[]): string {
  try {
    loadConfig(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  test("reads the gateway, token file and defaults", () => {
    expect(loadConfig(args())).toEqual({
      gatewayUrl: GATEWAY,
      tokenFile: TOKEN_FILE,
      caFile: undefined,
      answerTimeoutMs: DEFAULT_ANSWER_TIMEOUT_MS,
    });
  });

  test("keeps a path prefix and drops trailing slashes", () => {
    expect(loadConfig(args({ "gateway-url": "https://proxy.example.org/omnesis/" })).gatewayUrl).toBe(
      "https://proxy.example.org/omnesis",
    );
    expect(loadConfig(args({ "gateway-url": `${GATEWAY}/` })).gatewayUrl).toBe(GATEWAY);
  });

  test("requires the gateway address and the token file", () => {
    expect(configError(args({ "gateway-url": undefined }))).toBe(
      "--gateway-url is missing from the handler's command.",
    );
    expect(configError(args({ "token-file": undefined }))).toBe("--token-file is missing from the handler's command.");
    expect(configError(args({ "token-file": "  " }))).toBe("--token-file is missing from the handler's command.");
  });

  test("refuses flags it does not know and stray arguments", () => {
    expect(configError([...args(), "--insecure"])).toContain("--insecure");
    expect(configError([...args(), "extra"])).toContain("extra");
  });

  test("sends the token over plain http only to this machine", () => {
    for (const local of ["http://localhost:7600", "http://127.0.0.1:7600", "http://[::1]:7600"]) {
      expect(loadConfig(args({ "gateway-url": local })).gatewayUrl).toBe(local);
    }
    for (const remote of ["http://gateway.example.org:7600", "http://127.0.0.2:7600", "ftp://gateway.example.org"]) {
      expect(configError(args({ "gateway-url": remote }))).toContain("must use https");
    }
  });

  test("refuses an address that is not a plain gateway URL, never quoting credentials", () => {
    expect(configError(args({ "gateway-url": "gateway.example.org" }))).toBe("--gateway-url is not a URL.");
    expect(configError(args({ "gateway-url": `${GATEWAY}/?x=1` }))).toContain("plain gateway address");
    const withCredentials = configError(args({ "gateway-url": "https://user:hunter2@gateway.example.org" }));
    expect(withCredentials).toContain("without credentials");
    expect(withCredentials).not.toContain("hunter2");
    expect(configError(args({ "gateway-url": "http://user:hunter2@gateway.example.org" }))).not.toContain("hunter2");
  });

  test("needs absolute paths, since nothing expands ~ in Guv's command", () => {
    expect(configError(args({ "token-file": "~/guv.token" }))).toContain("must be an absolute path");
    expect(configError(args({ "ca-file": "ca.pem" }))).toContain("must be an absolute path");
  });

  test("takes the CA bundle's path, which is read per Job", () => {
    expect(loadConfig(args({ "ca-file": "/etc/omnesis/ca.pem" })).caFile).toBe("/etc/omnesis/ca.pem");
  });

  test("validates the time budget", () => {
    expect(loadConfig(args({ "answer-timeout-ms": "90000" })).answerTimeoutMs).toBe(90_000);
    for (const bad of ["", "0", "-5", "1.5", "soon", "86400001"]) {
      expect(configError(args({ "answer-timeout-ms": bad }))).toContain("--answer-timeout-ms");
    }
  });
});

describe("readToken", () => {
  test("reads the token without surrounding whitespace, every time", () => {
    writeFileSync(TOKEN_FILE, "omn_first\n");
    expect(readToken(TOKEN_FILE)).toBe("omn_first");
    writeFileSync(TOKEN_FILE, "omn_rotated\n");
    expect(readToken(TOKEN_FILE)).toBe("omn_rotated");
  });

  test("an empty, missing or unreadable file is a token-file error", () => {
    writeFileSync(TOKEN_FILE, "\n");
    expect(() => readToken(TOKEN_FILE)).toThrow(JobFileError);
    expect(() => readToken(TOKEN_FILE)).toThrow("is empty");
    expect(() => readToken(join(dir, "missing.token"))).toThrow("no such file");
    if (process.getuid?.() !== 0) {
      const locked = join(dir, "locked.token");
      writeFileSync(locked, "omn_x");
      chmodSync(locked, 0o000);
      expect(() => readToken(locked)).toThrow("permission denied");
    }
  });

  test("refuses a file that is not a single token, without repeating it", () => {
    for (const content of ['{\n  "token": "omn_secret"\n}', "omn_secret\nomn_other", "omn secret"]) {
      writeFileSync(TOKEN_FILE, content);
      const error = (() => {
        try {
          readToken(TOKEN_FILE);
        } catch (e) {
          return e as Error;
        }
        throw new Error("expected a JobFileError");
      })();
      expect(error).toBeInstanceOf(JobFileError);
      expect(error.message).toContain("does not hold a single token");
      expect(error.message).not.toContain("omn_secret");
    }
  });
});

describe("readCa", () => {
  // A throwaway self-signed certificate for a fictional name; only its shape matters.
  const VALID_CA = `-----BEGIN CERTIFICATE-----
MIIBkTCCATegAwIBAgIUTO7Uuz8hmxtuUvXlQNH7UpvcgwowCgYIKoZIzj0EAwIw
HjEcMBoGA1UEAwwTdGVzdC1jYS5leGFtcGxlLm9yZzAeFw0yNjA5MjMxNzQwNTla
Fw0zNjA5MjAxNzQwNTlaMB4xHDAaBgNVBAMME3Rlc3QtY2EuZXhhbXBsZS5vcmcw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARNeMHqRwFspw1WxjZ3UAX330fCa3sI
IDS3r8jkhBh3/JopMJ7nCaDZVF6zXRRLIDCVVm9/xGchfq+7bLeMs4Cso1MwUTAd
BgNVHQ4EFgQUaryC2uLuXAkUiY2VCS7JG3vf15EwHwYDVR0jBBgwFoAUaryC2uLu
XAkUiY2VCS7JG3vf15EwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBF
AiEAq938M9fiwGntCjif1nPoJF3Ry5qQe4v48grkwMyfgjMCIE74DW86N++EZInD
1+ra1YqtP0UWTw3AtfdC1wL7ODog
-----END CERTIFICATE-----`;
  // The same certificate with part of its body overwritten.
  const GARBLED_CA = VALID_CA.replace(/\n[A-Za-z0-9+/]{64}\n/, `\n${"A".repeat(64)}\n`);

  test("refuses a file without a certificate, or with one that does not parse", () => {
    const empty = join(dir, "empty.pem");
    writeFileSync(empty, "");
    expect(() => readCa(empty)).toThrow("holds no PEM certificate");
    const garbled = join(dir, "garbled.pem");
    writeFileSync(garbled, GARBLED_CA);
    expect(GARBLED_CA).not.toBe(VALID_CA);
    expect(() => readCa(garbled)).toThrow("cannot be parsed");
    expect(() => readCa(join(dir, "missing.pem"))).toThrow(JobFileError);
  });

  test("reads a real certificate, and each Job reads both files afresh", () => {
    const caFile = join(dir, "valid.pem");
    writeFileSync(caFile, VALID_CA);
    writeFileSync(TOKEN_FILE, "omn_first\n");
    expect(readJobFiles({ tokenFile: TOKEN_FILE, caFile })).toEqual({ token: "omn_first", ca: VALID_CA });
    writeFileSync(TOKEN_FILE, "omn_rotated\n");
    expect(readJobFiles({ tokenFile: TOKEN_FILE, caFile: undefined })).toEqual({ token: "omn_rotated", ca: undefined });
  });
});
