// SPDX-License-Identifier: MIT
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULT_ANSWER_TIMEOUT_MS, loadConfig, readToken } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "omnesis-guv-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN_FILE = join(dir, "guv.token");
const BASE = { OMNESIS_GATEWAY_URL: "https://gateway.example.org:7600", OMNESIS_TOKEN_FILE: TOKEN_FILE };

function configError(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("loadConfig", () => {
  test("reads the gateway, token file and defaults", () => {
    expect(loadConfig(BASE)).toEqual({
      gatewayUrl: "https://gateway.example.org:7600",
      tokenFile: TOKEN_FILE,
      ca: undefined,
      answerTimeoutMs: DEFAULT_ANSWER_TIMEOUT_MS,
    });
  });

  test("keeps a path prefix and drops trailing slashes", () => {
    expect(loadConfig({ ...BASE, OMNESIS_GATEWAY_URL: "https://proxy.example.org/omnesis/" }).gatewayUrl).toBe(
      "https://proxy.example.org/omnesis",
    );
    expect(loadConfig({ ...BASE, OMNESIS_GATEWAY_URL: "https://gateway.example.org:7600/" }).gatewayUrl).toBe(
      "https://gateway.example.org:7600",
    );
  });

  test("requires the gateway address and the token file", () => {
    expect(configError({ OMNESIS_TOKEN_FILE: TOKEN_FILE })).toContain("OMNESIS_GATEWAY_URL is not set");
    expect(configError({ OMNESIS_GATEWAY_URL: "https://gateway.example.org" })).toContain("OMNESIS_TOKEN_FILE is not set");
    expect(configError({ ...BASE, OMNESIS_TOKEN_FILE: "  " })).toContain("OMNESIS_TOKEN_FILE is not set");
  });

  test("sends the token over plain http only to this machine", () => {
    expect(loadConfig({ ...BASE, OMNESIS_GATEWAY_URL: "http://localhost:7600" }).gatewayUrl).toBe("http://localhost:7600");
    expect(loadConfig({ ...BASE, OMNESIS_GATEWAY_URL: "http://127.0.0.1:7600" }).gatewayUrl).toBe("http://127.0.0.1:7600");
    expect(configError({ ...BASE, OMNESIS_GATEWAY_URL: "http://gateway.example.org:7600" })).toContain("must use https");
    expect(configError({ ...BASE, OMNESIS_GATEWAY_URL: "ftp://gateway.example.org" })).toContain("must use https");
  });

  test("refuses an address that is not a plain gateway URL", () => {
    expect(configError({ ...BASE, OMNESIS_GATEWAY_URL: "gateway.example.org" })).toContain("is not a URL");
    expect(configError({ ...BASE, OMNESIS_GATEWAY_URL: "https://gateway.example.org/?x=1" })).toContain("plain gateway address");
    expect(configError({ ...BASE, OMNESIS_GATEWAY_URL: "https://user:pw@gateway.example.org" })).toContain(
      "plain gateway address",
    );
  });

  test("needs absolute paths, since nothing expands ~ in the daemon's environment", () => {
    expect(configError({ ...BASE, OMNESIS_TOKEN_FILE: "~/guv.token" })).toContain("must be an absolute path");
    expect(configError({ ...BASE, OMNESIS_CA_FILE: "ca.pem" })).toContain("must be an absolute path");
  });

  test("reads a CA bundle when one is named", () => {
    const caFile = join(dir, "ca.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\n");
    expect(loadConfig({ ...BASE, OMNESIS_CA_FILE: caFile }).ca).toBe("-----BEGIN CERTIFICATE-----\n");
    expect(configError({ ...BASE, OMNESIS_CA_FILE: join(dir, "missing.pem") })).toContain("ENOENT");
  });

  test("validates the time budget", () => {
    expect(loadConfig({ ...BASE, OMNESIS_ANSWER_TIMEOUT_MS: "90000" }).answerTimeoutMs).toBe(90_000);
    for (const bad of ["0", "-5", "1.5", "soon", "1e400"]) {
      expect(configError({ ...BASE, OMNESIS_ANSWER_TIMEOUT_MS: bad })).toContain("OMNESIS_ANSWER_TIMEOUT_MS");
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

  test("an empty, missing or unreadable file is a configuration error", () => {
    writeFileSync(TOKEN_FILE, "\n");
    expect(() => readToken(TOKEN_FILE)).toThrow("is empty");
    expect(() => readToken(join(dir, "missing.token"))).toThrow("ENOENT");
    if (process.getuid?.() !== 0) {
      const locked = join(dir, "locked.token");
      writeFileSync(locked, "omn_x");
      chmodSync(locked, 0o000);
      expect(() => readToken(locked)).toThrow("EACCES");
    }
  });
});
