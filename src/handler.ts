// SPDX-License-Identifier: MIT
// The Guv handler process: every Job is one question to Omnesis's `/answer`.
// Guv starts it (`bun src/handler.ts` in this checkout) and talks to it over
// the socket `serveHandler` opens; the OMNESIS_* environment configures it.

import { serveHandler } from "@familiar/guv-handler-sdk/process";
import { ConfigError, loadConfig, type HandlerConfig } from "./config.js";
import { answerJob, defaultJobDeps } from "./job.js";

// A bad configuration is reported on every Job, where the person can read it,
// rather than crashing the process into Guv's restart loop.
let config: HandlerConfig | Error;
try {
  config = loadConfig(process.env);
} catch (error) {
  config = error instanceof ConfigError ? error : new ConfigError(String(error));
}

const deps = defaultJobDeps(config);
await serveHandler((input) => answerJob(input, deps));
