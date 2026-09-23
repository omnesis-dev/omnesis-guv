// SPDX-License-Identifier: MIT
// The Guv handler process: every Job is one question to Omnesis's `/answer`.
// Guv starts it with the command in its handler configuration (see
// handler.config.example.json) and talks to it over the socket `serveHandler`
// opens.

import { serveHandler } from "@familiar/guv-handler-sdk/process";
import { ConfigError, loadConfig, type HandlerConfig } from "./config.js";
import { answerJob, productionJobDeps } from "./job.js";

/**
 * How many answers the gateway makes at once for one integration. Guv runs this
 * many Jobs at a time unless the handler configuration sets `max_concurrency`;
 * more would only wait on the gateway's turn limit inside their time budget.
 */
const GATEWAY_ANSWERS_AT_ONCE = 2;

// A wrong command line is reported on every Job, where the person can read
// it, rather than crashing the process into Guv's restart loop.
let config: HandlerConfig | ConfigError;
try {
  config = loadConfig(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  config = error;
}

const deps = productionJobDeps(config);
await serveHandler((input) => answerJob(input, deps), { defaultMaxConcurrency: GATEWAY_ANSWERS_AT_ONCE });
