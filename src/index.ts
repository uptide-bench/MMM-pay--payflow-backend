import { loadConfig } from "./config.ts";
import { openDatabase } from "./lib/db.ts";
import { makeRpc } from "./lib/stellar.ts";
import { createApp } from "./app.ts";
import { Indexer } from "./indexer.ts";
import { Keeper } from "./keeper.ts";
import type { AdminHooks } from "./routes/admin.ts";
import { logger } from "./lib/logger.ts";
import { drain, every, serial, type Loop } from "./lib/loop.ts";
import { initTelemetry, withSpan } from "./lib/telemetry.ts";

const config = loadConfig();
const stopTelemetry = initTelemetry(config.OTEL_EXPORTER_OTLP_ENDPOINT);
const db = openDatabase(config.DATABASE_PATH);
const server = makeRpc(config);

const indexer = new Indexer(db, server, config);
const keeper = config.KEEPER_ENABLED ? new Keeper(db, server, config) : undefined;
const activeKeeper = keeper;
if (keeper) {
  logger.info({ keeper: keeper.publicKey }, "keeper enabled");
} else {
  logger.info("keeper disabled (KEEPER_ENABLED=false)");
}

// Each runner is serialized, and the scheduled loop and the /admin trigger
// share it: a pass can take longer than the interval while backfilling, and
// overlapping passes would race on the cursor and, for the keeper, on the
// account sequence number.
const runIndexerPass = serial(async () => {
  try {
    const r = await withSpan("indexer.pass", () => indexer.tick());
    indexer.status.lastRunAt = Date.now();
    indexer.status.lastError = null;
    if (r.applied > 0) logger.info({ events: r.applied, cursor: r.cursor }, "indexed");
    return r;
  } catch (err) {
    indexer.status.lastError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "indexer pass failed");
    throw err;
  }
});

const runKeeperPass = keeper
  ? serial(async () => {
      try {
        const results = await withSpan("keeper.pass", () => keeper.tick());
        const settled = results.filter((r) => r.status === "settled").length;
        if (results.length > 0) logger.info({ settled, attempted: results.length }, "keeper pass");
        return results;
      } catch (err) {
        logger.error({ err }, "keeper pass failed");
        throw err;
      }
    })
  : undefined;

const adminHooks: AdminHooks = { reindex: () => runIndexerPass() };
if (keeper && runKeeperPass) {
  adminHooks.keeperPass = () => runKeeperPass();
  adminHooks.keeperBackoff = () => keeper.backoffList();
}

const app = createApp(db, config, indexer.status, indexer.merchantCache, server, adminHooks);
// Express 5 passes listen errors (e.g. EADDRINUSE) to this callback instead
// of letting them surface as an unhandled 'error' event, so fail fast here —
// otherwise the process would keep running without serving the API.
const http = app.listen(config.PORT, (err?: Error) => {
  if (err) {
    logger.fatal({ err, port: config.PORT }, "api failed to listen");
    process.exit(1);
  }
  logger.info({ port: config.PORT, network: config.STELLAR_NETWORK }, "api listening");
});

const loops: Loop[] = [];

loops.push(
  every(config.INDEXER_INTERVAL_MS, async () => {
    try {
      await runIndexerPass();
    } catch {
      // Handled in runIndexerPass
    }
  }),
);

if (runKeeperPass) {
  loops.push(
    every(config.KEEPER_INTERVAL_MS, async () => {
      try {
        await runKeeperPass();
      } catch {
        // Handled in runKeeperPass
      }
    }),
  );
}

/**
 * Rotate the keeper key without downtime: update KEEPER_SECRET /
 * KEEPER_SECRET_NEXT (and the rest of the env), then `kill -HUP <pid>`.
 * Node re-reads `.env`, the config is re-validated and the running keeper
 * swaps its signing keys mid-loop; the next successful pass logs that the
 * previous key can be retired.
 */
process.on("SIGHUP", () => {
  logger.info("SIGHUP received; reloading configuration");
  try {
    process.loadEnvFile();
  } catch {
    // No .env file to re-read; the process environment is the source of truth.
  }
  try {
    const next = loadConfig();
    if (activeKeeper) {
      activeKeeper.reloadFromConfig(next);
    } else {
      logger.info("configuration reloaded; keeper is not running");
    }
  } catch (err) {
    logger.error({ err }, "configuration reload failed; keeping the previous config");
  }
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  // Let a pass that is mid-write or mid-transaction finish before the database
  // closes, but never hang forever on a stuck RPC call.
  const outcome = await drain(loops, config.SHUTDOWN_TIMEOUT_MS);
  if (outcome === "timeout") logger.warn({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS }, "passes still running; closing anyway");
  await stopTelemetry().catch(() => {});
  http.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
