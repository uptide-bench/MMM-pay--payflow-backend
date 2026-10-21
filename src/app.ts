import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import type { IndexerStatus } from "./indexer.ts";
import { buildAdminRoutes, type AdminHooks } from "./routes/admin.ts";
import { buildRoutes, MerchantSummaryCache } from "./routes/index.ts";
import type { HealthResponse } from "./routes/types.ts";
import type { RpcStatus } from "./lib/stellar.ts";
import { logger } from "./lib/logger.ts";
import { withSpan } from "./lib/telemetry.ts";

/** Ledgers the indexer may trail the network by before it is considered behind. */
const MAX_LAG = 120;

/** Ledgers the projection trails the network by; null until the first pass. */
function lagOf(indexer: IndexerStatus | undefined): number | null {
  return indexer && indexer.latest > 0 ? Math.max(0, indexer.latest - indexer.cursor) : null;
}

export function createApp(
  db: DatabaseSync,
  config: Config,
  indexer?: IndexerStatus,
  arg3?: MerchantSummaryCache | RpcStatus | AdminHooks,
  arg4?: RpcStatus | AdminHooks,
  arg5?: AdminHooks,
): Express {
  let merchantCache: MerchantSummaryCache | undefined;
  let rpc: RpcStatus | undefined;
  let admin: AdminHooks | undefined;

  for (const arg of [arg3, arg4, arg5]) {
    if (!arg) continue;
    if (arg instanceof MerchantSummaryCache) {
      merchantCache = arg;
    } else if ("active" in arg && Array.isArray((arg as RpcStatus).endpoints)) {
      rpc = arg as RpcStatus;
    } else if (typeof arg === "object") {
      admin = arg as AdminHooks;
    }
  }

  const app = express();
  // Express 5 defaults to the "simple" (node:querystring) parser; keep the
  // Express 4 qs-based parser so bracketed params (`?merchant[]=G…`) still
  // reach the filters instead of being dropped, which would widen results.
  app.set("query parser", "extended");

  app.use(
    pinoHttp({
      logger,
      // Accept a caller's id (bounded, so it cannot flood logs) or mint one.
      genReqId: (req, res) => {
        const given = req.headers["x-request-id"];
        const id = typeof given === "string" && /^[\w.-]{1,128}$/.test(given) ? given : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
      },
    }),
  );
  app.use((req, res, next) => {
    void withSpan(`${req.method} request`, () => {
      return new Promise<void>((resolve) => {
        res.once("close", resolve);
        next();
      });
    });
  });
  app.use(
    cors({
      origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(","),
      // Browsers hide non-safelisted response headers from scripts unless exposed.
      exposedHeaders: ["X-Request-Id"],
    }),
  );
  app.use(express.json({ limit: "64kb" }));

  // Always 200 so a slow backfill does not get the service restarted; the
  // body says whether the projection is current.
  app.get("/health", (_req, res) => {
    const lag = lagOf(indexer);
    const freshnessSeconds = indexer
      ? (indexer.freshnessSeconds ??
         (indexer.lastLedgerCloseTime != null
           ? Math.max(0, Math.floor(Date.now() / 1000) - indexer.lastLedgerCloseTime)
           : null))
      : null;
    const body: HealthResponse = {

      status: lag === null ? "starting" : lag <= MAX_LAG ? "ok" : "catching_up",
      network: config.STELLAR_NETWORK,
      indexer: indexer
        ? {
            cursor: indexer.cursor,
            latestLedger: indexer.latest,
            lag,
            freshnessSeconds,
            lastRunAt: indexer.lastRunAt ? new Date(indexer.lastRunAt).toISOString() : null,
            lastError: indexer.lastError,
            mismatchedEvents: indexer.mismatchedEvents ?? 0,
          }
        : null,
      rpc: rpc ? { active: rpc.active, endpoints: rpc.endpoints } : null,
      contracts: {
        planRegistry: config.PLAN_REGISTRY_ID,
        vault: config.VAULT_ID,
        subscription: config.SUBSCRIPTION_ID,
      },
    };
    res.json(body);
  });

  // Readiness for orchestrators: 503 until the projection trails the network
  // by no more than the same threshold /health uses, so traffic is not sent
  // to an instance that is still backfilling. An unknown lag (no indexer has
  // run yet, or none is attached) is treated as not ready, since the
  // freshness of the projection cannot be established.
  app.get("/ready", (_req, res) => {
    const lag = lagOf(indexer);
    const ready = lag !== null && lag <= MAX_LAG;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : lag === null ? "starting" : "catching_up",
      lag,
    });
  });

  // Operator endpoints are opt-in. Without ADMIN_TOKEN — or without hooks —
  // /admin falls through to the 404 below like any unknown path.
  if (config.ADMIN_TOKEN && admin) {
    app.use("/admin", buildAdminRoutes(config.ADMIN_TOKEN, admin));
  }

  app.use("/api", buildRoutes(db, merchantCache, config.TOKEN_ID));


  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "unhandled request error");
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
