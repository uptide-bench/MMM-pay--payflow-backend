import assert from "node:assert/strict";
import { test, describe, before, after, mock } from "node:test";
import type { Server } from "node:http";
import express, { type Express, type Request, type Response } from "express";
import { openDatabase } from "../src/lib/db.ts";
import { createApp, errorHandler, loggableError } from "../src/app.ts";
import { logger } from "../src/lib/logger.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";
import { MerchantSummaryCache } from "../src/routes/index.ts";
import type { MerchantSummary } from "../src/routes/types.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
const YEARLY_MERCHANT = "GDLXOW3J5FEFW4UZ7XBHX6EFHL7POV7S2NG5RZ7ULYCGLJWGPUBFQO4U";
const FORECAST_MERCHANT = "GA5WDTXMB5SW2DIVYCXKQ36M3LWPSGVPYQWRTMLERMZSPGYQXVQ2N55B";
const CAPPED_MERCHANT = "GCP3XZ2Z4XLRTNBRD7KWWLE7K4LRBNTBVF37LWZRY2MEEK3GZ3RWZG7Y";
/** Frozen at load; forecast fixtures hang off it so the window maths is stable. */
const NOW = Math.floor(Date.now() / 1000);

const config = {
  STELLAR_NETWORK: "testnet",
  PLAN_REGISTRY_ID: "C".repeat(56),
  VAULT_ID: "C".repeat(56),
  SUBSCRIPTION_ID: "C".repeat(56),
  CORS_ORIGIN: "*",
  PORT: 0,
} as unknown as Config;

let server: Server;
let ix: Indexer;
const status = {
  cursor: 1_000,
  latest: 1_010,
  lastRunAt: Date.now(),
  lastError: null,
  lastLedgerCloseTime: 1_700_000_000,
  freshnessSeconds: 42,
};
let base: string;
const db = openDatabase(":memory:");

const ev = (name: string, topics: unknown[], data: Record<string, unknown>, tx = "t"): DecodedEvent => ({
  name, contractId: "C", ledger: 1, txHash: tx, topics, data,
});

before(async () => {
  ix = new Indexer(db, {} as never, {} as never);

  ix.apply(ev("plan_created", [MERCHANT, 1n], { token: "C", amount: 10_000_000n, period: 2_592_000n }));
  ix.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 10_000_000n, period: 2_592_000n, next_charge: 1n,
  }));
  ix.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
    amount: 9_900_000n, fee: 100_000n, charges_made: 1n, next_charge: 4_000_000_000n,
  }, "tx1"));

  // A yearly plan: one charge of 120_000_000 per 365-day period, next charge
  // far in the future so it never lands in the due list.
  ix.apply(ev("subscribed", [2n, SUBSCRIBER, YEARLY_MERCHANT], {
    plan_id: 1n, amount: 120_000_000n, period: 31_536_000n, next_charge: 4_000_000_000n,
  }, "tx2"));

  // Forecast fixtures: a daily mandate net of a 1% fee, and one capped at two
  // charges. The first charge is an hour away, so /due stays empty.
  ix.apply(ev("subscribed", [3n, SUBSCRIBER, FORECAST_MERCHANT], {
    plan_id: 1n, amount: 5_000_000n, period: 86_400n,
    next_charge: BigInt(NOW + 3_600), max_charges: 0n, fee_bps: 100n,
  }, "tx3"));
  ix.apply(ev("subscribed", [4n, SUBSCRIBER, CAPPED_MERCHANT], {
    plan_id: 1n, amount: 2_000_000n, period: 86_400n,
    next_charge: BigInt(NOW + 3_600), max_charges: 2n, fee_bps: 0n,
  }, "tx4"));

  const app = createApp(db, config, status, ix.merchantCache);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  db.close();
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() as Record<string, never> };
};

describe("http api", () => {
  test("health reports contract wiring", async () => {
    const { status, body } = await get("/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
  });

  test("health reports indexer lag", async () => {
    const { body } = await get("/health");
    const ix = body.indexer as unknown as { cursor: number; lag: number };
    assert.equal(ix.cursor, 1_000);
    assert.equal(ix.lag, 10);
  });

  test("health reports freshnessSeconds", async () => {
    const { body } = await get("/health");
    const ixStatus = body.indexer as unknown as { freshnessSeconds: number };
    assert.equal(ixStatus.freshnessSeconds, 42);
  });

  test("health says catching_up while far behind, but stays 200", async () => {
    status.latest = 50_000;
    try {
      const res = await get("/health");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "catching_up");
    } finally {
      status.latest = 1_010;
    }
  });

  test("readiness passes once the projection has caught up", async () => {
    const { status: code, body } = await get("/ready");
    assert.equal(code, 200);
    assert.equal(body.status, "ready");
    assert.equal(body.lag, 10);
  });

  test("readiness fails while the indexer is catching up", async () => {
    status.latest = 50_000;
    try {
      const res = await get("/ready");
      assert.equal(res.status, 503);
      assert.equal(res.body.status, "catching_up");
      assert.equal(res.body.lag, 49_000);
    } finally {
      status.latest = 1_010;
    }
  });

  test("readiness fails before the indexer's first pass", async () => {
    status.latest = 0;
    try {
      const res = await get("/ready");
      assert.equal(res.status, 503);
      assert.equal(res.body.status, "starting");
      assert.equal(res.body.lag, null);
    } finally {
      status.latest = 1_010;
    }
  });

  test("lists plans and filters by merchant", async () => {
    const all = await get("/api/plans");
    assert.equal((all.body.plans as unknown[]).length, 1);

    const mine = await get(`/api/plans?merchant=${MERCHANT}`);
    assert.equal((mine.body.plans as unknown[]).length, 1);

    const none = await get("/api/plans?merchant=GNOBODY");
    assert.equal((none.body.plans as unknown[]).length, 0);
  });

  test("unknown plan is 404", async () => {
    const { status } = await get("/api/plans/999");
    assert.equal(status, 404);
  });

  test("mandate charge history", async () => {
    const { body } = await get("/api/mandates/1/charges");
    assert.equal((body.charges as unknown[]).length, 1);
  });

  test("batch mandate lookup omits unknown ids", async () => {
    const { body } = await get("/api/mandates?ids=1,2,999");
    const rows = body.mandates as unknown as { id: number }[];
    assert.deepEqual(
      rows.map((r) => r.id), // ORDER BY id DESC, as the list endpoint always does
      [2, 1],
    );
  });

  test("batch mandate lookup rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1).join(",");
    const { status, body } = await get(`/api/mandates?ids=${ids}`);
    assert.equal(status, 400);
    assert.equal(body.error, "too_many_ids");
  });

  test("batch mandate lookup rejects a non-numeric id", async () => {
    const { status, body } = await get("/api/mandates?ids=1,nope");
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_ids");
  });

  test("merchant summary computes MRR, ARR and revenue", async () => {
    const { body } = await get(`/api/merchants/${MERCHANT}/summary`);
    assert.equal(body.activeMandates, 1);
    assert.equal(body.totalCollected, "9900000");
    // 10_000_000 per 30-day period normalises to itself, twelve times a year
    assert.equal(body.mrr, "10000000");
    assert.equal(body.arr, "121666666");
  });

  test("yearly plan fixture gives the expected ARR", async () => {
    const { body } = await get(`/api/merchants/${YEARLY_MERCHANT}/summary`);
    assert.equal(body.activeMandates, 1);
    // 120_000_000 per 365-day period is the ARR itself...
    assert.equal(body.arr, "120000000");
    // ...and the same amount normalised to a 30-day month is smaller than ARR.
    assert.equal(body.mrr, "9863013");
  });

  test("forecast sums the next 30 days net of fees", async () => {
    const { body } = await get(`/api/merchants/${FORECAST_MERCHANT}/forecast`);
    assert.equal(body.days, 30);
    assert.equal(body.to as number - (body.from as number), 30 * 86_400);
    assert.equal(body.mandateCount, 1);
    // 5_000_000 per day, 1% fee -> 4_950_000 x 30 occurrences
    assert.equal(body.forecast, "148500000");
    assert.ok(Array.isArray(body.assumptions) && (body.assumptions as unknown[]).length > 0);
  });

  test("forecast respects the days parameter", async () => {
    const one = await get(`/api/merchants/${FORECAST_MERCHANT}/forecast?days=1`);
    assert.equal(one.body.days, 1);
    assert.equal(one.body.forecast, "4950000");

    const malformed = await get(`/api/merchants/${FORECAST_MERCHANT}/forecast?days=nope`);
    assert.equal(malformed.body.days, 30);
  });

  test("forecast stops at max_charges and ignores unknown merchants", async () => {
    const capped = await get(`/api/merchants/${CAPPED_MERCHANT}/forecast`);
    // two charges fit in 30 days, but the mandate is capped at two
    assert.equal(capped.body.mandateCount, 1);
    assert.equal(capped.body.forecast, "4000000");

    const none = await get("/api/merchants/GNOBODY/forecast");
    assert.equal(none.body.mandateCount, 0);
    assert.equal(none.body.forecast, "0");
  });

  test("subscriber summary includes fee in total paid", async () => {
    const { body } = await get(`/api/subscribers/${SUBSCRIBER}/summary`);
    assert.equal(body.totalPaid, "10000000");
  });

  test("due list excludes future charges", async () => {
    const { body } = await get("/api/due");
    assert.equal((body.due as unknown[]).length, 0);
  });

  test("stats reflect indexed state", async () => {
    const { body } = await get("/api/stats");
    assert.equal(body.plans, 1);
    assert.equal(body.mandates, 4);
    assert.equal(body.charges, 1);
  });

  test("unknown route is 404 json", async () => {
    const { status, body } = await get("/nope");
    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });

  test("every response carries an X-Request-Id, reusing the caller's", async () => {
    const generated = await fetch(`${base}/health`);
    assert.ok(generated.headers.get("x-request-id"));
    const missing = await fetch(`${base}/nope`);
    assert.ok(missing.headers.get("x-request-id"));
    const echoed = await fetch(`${base}/health`, { headers: { "X-Request-Id": "abc-123" } });
    assert.equal(echoed.headers.get("x-request-id"), "abc-123");
  });

  test("X-Request-Id is exposed to browsers through CORS", async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: "http://localhost:3000" } });
    assert.match(res.headers.get("access-control-expose-headers") ?? "", /x-request-id/i);
  });
});

describe("merchant summary caching", () => {
  test("invalidates after a new charge", async () => {
    const memDb = openDatabase(":memory:");
    const cache = new MerchantSummaryCache();
    const indexer = new Indexer(memDb, {} as never, {} as never, cache);
    indexer.apply(ev("plan_created", [MERCHANT, 1n], { token: "C", amount: 10_000_000n, period: 2_592_000n }));
    indexer.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
      plan_id: 1n, amount: 10_000_000n, period: 2_592_000n, next_charge: 1n,
    }));
    indexer.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 9_900_000n, fee: 100_000n, charges_made: 1n, next_charge: 4_000_000_000n,
    }, "tx1"));

    const app = createApp(memDb, config, status, cache);
    const testServer = app.listen(0);
    const addr = testServer.address();
    const testBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    try {
      const firstRes = await fetch(`${testBase}/api/merchants/${MERCHANT}/summary`);
      const first = (await firstRes.json()) as MerchantSummary;
      assert.equal(first.chargeCount, 1);
      assert.equal(first.totalCollected, "9900000");

      // Apply a second charge
      indexer.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
        amount: 5_000_000n, fee: 50_000n, charges_made: 2n, next_charge: 5_000_000_000n,
      }, "tx2"));

      const secondRes = await fetch(`${testBase}/api/merchants/${MERCHANT}/summary`);
      const second = (await secondRes.json()) as MerchantSummary;
      assert.equal(second.chargeCount, 2);
      assert.equal(second.totalCollected, "14900000");
    } finally {
      testServer.close();
      memDb.close();
    }
  });

  test("memory is bounded by evicting oldest entries", () => {
    const cache = new MerchantSummaryCache(2);
    const mockSummary = (m: string): MerchantSummary => ({
      merchant: m,
      activeMandates: 1,
      totalCollected: "100",
      chargeCount: 1,
      mrr: "10",
      arr: "120",
      tokens: [],
    });

    cache.set("m1", mockSummary("m1"));
    cache.set("m2", mockSummary("m2"));
    assert.equal(cache.size, 2);

    // Access m1 so m2 is the least recently used
    assert.equal(cache.get("m1")?.merchant, "m1");

    // Inserting 3rd entry evicts m2
    cache.set("m3", mockSummary("m3"));
    assert.equal(cache.size, 2);
    assert.equal(cache.get("m1")?.merchant, "m1");
    assert.equal(cache.get("m2"), undefined);
    assert.equal(cache.get("m3")?.merchant, "m3");
  });
});

describe("stats volume", () => {
  const MERCHANT2 = "GBIWM7VWG7UBSHPOXG7XQV6M4EXG2XC5JQER6IZU35VS2DGLTJX7UVOM";
  const statsDb = openDatabase(":memory:");
  const statsIx = new Indexer(statsDb, {} as never, {} as never);
  let statsServer: Server;
  let statsBase: string;

  const ev = (
    name: string,
    topics: unknown[],
    data: Record<string, unknown>,
    tx = "t",
  ): DecodedEvent => ({ name, contractId: "C", ledger: 1, txHash: tx, topics, data });

  const statsGet = async (path: string) => {
    const res = await fetch(statsBase + path);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  before(async () => {
    // One active merchant with a recent charge and one from two days ago, and
    // a cancelled merchant that must not count as active.
    statsIx.apply(ev("plan_created", [MERCHANT, 1n], {
      token: "CTOKEN", amount: 10_000_000n, period: 2_592_000n, name: "p1",
    }));
    statsIx.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
      plan_id: 1n, amount: 10_000_000n, period: 2_592_000n, next_charge: 4_000_000_000n,
    }));
    statsIx.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 2_000_000n, fee: 100_000n, charges_made: 1n, next_charge: 4_000_000_000n,
    }, "tx-old"));
    statsIx.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 3_000_000n, fee: 150_000n, charges_made: 2n, next_charge: 4_000_000_000n,
    }, "tx-recent"));
    statsDb
      .prepare("UPDATE charges SET created_at = ? WHERE tx_hash = ?")
      .run(Date.now() - 2 * 86_400_000, "tx-old");

    statsIx.apply(ev("plan_created", [MERCHANT2, 2n], {
      token: "CTOKEN", amount: 1_000_000n, period: 2_592_000n, name: "p2",
    }));
    statsIx.apply(ev("subscribed", [2n, SUBSCRIBER, MERCHANT2], {
      plan_id: 2n, amount: 1_000_000n, period: 2_592_000n, next_charge: 4_000_000_000n,
    }));
    statsIx.apply(ev("cancelled", [2n, SUBSCRIBER], { charges_made: 0 }));

    const app = createApp(statsDb, config);
    await new Promise<void>((resolve) => {
      statsServer = app.listen(0, () => {
        const addr = statsServer.address();
        statsBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    statsServer.close();
    statsDb.close();
  });

  test("stats report volume, fees and active merchants as decimal strings", async () => {
    const { body } = await statsGet("/api/stats");
    assert.equal(body.plans, 2);
    assert.equal(body.mandates, 2);
    assert.equal(body.activeMandates, 1);
    assert.equal(body.charges, 2);
    // Only the merchant with an active mandate counts.
    assert.equal(body.activeMerchants, 1);
    // Gross volume and fees across every charge: 2_100_000 + 3_150_000.
    assert.equal(body.volumeAllTime, "5250000");
    assert.equal(body.totalFees, "250000");
    for (const field of ["volume24h", "volumeAllTime", "totalFees"]) {
      assert.equal(typeof body[field], "string", `${field} is a string`);
    }
  });

  test("the 24-hour window counts only recent charges", async () => {
    const { body } = await statsGet("/api/stats");
    // The charge from two days ago is excluded: 3_000_000 + 150_000.
    assert.equal(body.volume24h, "3150000");
  });
});
describe("merchant revenue per token", () => {
  const TOKEN_A = "CTOKEN_A";
  const TOKEN_B = "CTOKEN_B";
  const TOKEN_C = "CTOKEN_C";
  const tokenDb = openDatabase(":memory:");
  const tokenIx = new Indexer(tokenDb, {} as never, {} as never);
  const tokenServers: Server[] = [];

  const ev = (
    name: string,
    topics: unknown[],
    data: Record<string, unknown>,
    tx = "t",
  ): DecodedEvent => ({ name, contractId: "C", ledger: 1, txHash: tx, topics, data });

  const start = async (cfg: Config): Promise<string> => {
    const server = await new Promise<Server>((resolve) => {
      const s = createApp(tokenDb, cfg).listen(0, () => resolve(s));
    });
    tokenServers.push(server);
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  };

  const summaryGet = async (base: string, path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  let plainBase: string;
  let scopedBase: string;

  before(async () => {
    // One merchant with a plan in each of three tokens: two charged, one not.
    const plans: [bigint, string, bigint][] = [
      [1n, TOKEN_A, 10_000_000n],
      [2n, TOKEN_B, 5_000_000n],
      [3n, TOKEN_C, 2_000_000n],
    ];
    for (const [id, token, amount] of plans) {
      tokenIx.apply(ev("plan_created", [MERCHANT, id], {
        token, amount, period: 2_592_000n, name: `p${id}`,
      }));
      tokenIx.apply(ev("subscribed", [id, SUBSCRIBER, MERCHANT], {
        plan_id: id, amount, period: 2_592_000n, next_charge: 4_000_000_000n,
      }));
    }
    tokenIx.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
      amount: 9_900_000n, fee: 100_000n, charges_made: 1n, next_charge: 4_000_000_000n,
    }, "ta1"));
    tokenIx.apply(ev("charged", [2n, SUBSCRIBER, MERCHANT], {
      amount: 4_950_000n, fee: 50_000n, charges_made: 1n, next_charge: 4_000_000_000n,
    }, "tb1"));

    plainBase = await start(config);
    // A default token that is not the first one, so selection is provable.
    scopedBase = await start({ ...config, TOKEN_ID: TOKEN_B } as unknown as Config);
  });

  after(() => {
    for (const server of tokenServers) server.close();
    tokenDb.close();
  });

  const breakdown = [
    { token: TOKEN_A, totalCollected: "9900000", mrr: "10000000" },
    { token: TOKEN_B, totalCollected: "4950000", mrr: "5000000" },
    { token: TOKEN_C, totalCollected: "0", mrr: "2000000" },
  ];

  test("summary groups revenue per token; without a default the totals span all", async () => {
    const { body } = await summaryGet(plainBase, `/api/merchants/${MERCHANT}/summary`);
    assert.deepEqual(body.tokens, breakdown);
    assert.equal(body.activeMandates, 3);
    // No TOKEN_ID: the flat fields keep their previous all-token meaning.
    assert.equal(body.totalCollected, "14850000");
    assert.equal(body.mrr, "17000000");
    assert.equal(body.chargeCount, 2);
  });

  test("TOKEN_ID scopes the flat fields to the default token", async () => {
    const { body } = await summaryGet(scopedBase, `/api/merchants/${MERCHANT}/summary`);
    assert.equal(body.totalCollected, "4950000");
    assert.equal(body.mrr, "5000000");
    // The breakdown and the charge count still cover every token.
    assert.deepEqual(body.tokens, breakdown);
    assert.equal(body.chargeCount, 2);
  });

  test("an unknown merchant has an empty breakdown and zero totals", async () => {
    const { body } = await summaryGet(plainBase, "/api/merchants/GNOBODY/summary");
    assert.deepEqual(body.tokens, []);
    assert.equal(body.totalCollected, "0");
    assert.equal(body.mrr, "0");
  });
});

// Upcoming-charges fixtures hang off a single instant so the window maths is
// stable: requests happen milliseconds later, far inside the tolerances used.
const UP_NOW = Math.floor(Date.now() / 1000);

const DUE_SUB = `GDUE${"A".repeat(52)}`;
const FUTURE_SUB = `GFUT${"B".repeat(52)}`;
const CAPPED_SUB = `GCAP${"C".repeat(52)}`;
const SPENT_SUB = `GSPENT${"D".repeat(50)}`;
const FAST_SUB = `GFAST${"E".repeat(51)}`;
const MIXED_SUB = `GMIX${"F".repeat(52)}`;

const M_DUE = `GMDUE${"M".repeat(51)}`;
const M_FUTURE = `GMFUT${"M".repeat(51)}`;
const M_CAPPED = `GMCAP${"M".repeat(51)}`;
const M_SPENT = `GMSPENT${"M".repeat(49)}`;
const M_FAST = `GMFAST${"M".repeat(50)}`;
const M_WEEKLY = `GMWEEK${"M".repeat(50)}`;
const M_DAILY = `GMDAIL${"M".repeat(50)}`;

interface UpcomingCharge {
  mandateId: number;
  merchant: string;
  amount: string;
  at: number;
}

interface UpcomingBody {
  subscriber: string;
  days: number;
  now: number;
  until: number;
  upcoming: UpcomingCharge[];
  totalUpcoming: string;
  truncated: boolean;
  assumptions: unknown[];
}

describe("subscriber upcoming charges", () => {
  let upServer: Server;
  let upBase: string;
  const upDb = openDatabase(":memory:");

  before(async () => {
    const ix = new Indexer(upDb, {} as never, {} as never);
    const upEv = (name: string, topics: unknown[], data: Record<string, unknown>, tx: string): DecodedEvent => ({
      name, contractId: "C", ledger: 1, txHash: tx, topics, data,
    });
    const sub = (id: number, subscriber: string, merchant: string, data: Record<string, unknown>): void =>
      ix.apply(upEv("subscribed", [BigInt(id), subscriber, merchant], { plan_id: 1n, ...data }, `sub-${id}`));

    // Due an hour ago: projected from now, not from the stale next_charge.
    sub(101, DUE_SUB, M_DUE, {
      amount: 5_000_000n, period: 86_400n, next_charge: BigInt(UP_NOW - 3_600), max_charges: 0n, fee_bps: 0n,
    });
    // First charge an hour out: the anchor is exactly its next_charge.
    sub(102, FUTURE_SUB, M_FUTURE, {
      amount: 2_000_000n, period: 86_400n, next_charge: BigInt(UP_NOW + 3_600), max_charges: 0n, fee_bps: 0n,
    });
    // One of two allowed charges already made: one remains.
    sub(103, CAPPED_SUB, M_CAPPED, {
      amount: 1_000_000n, period: 86_400n, next_charge: BigInt(UP_NOW + 3_600), max_charges: 2n, fee_bps: 0n,
    });
    ix.apply(upEv("charged", [103n, CAPPED_SUB, M_CAPPED], {
      amount: 1_000_000n, fee: 0n, charges_made: 1n, next_charge: BigInt(UP_NOW + 3_600),
    }, "charge-103"));
    // Allowance used up: nothing more will ever be charged.
    sub(104, SPENT_SUB, M_SPENT, {
      amount: 2_000_000n, period: 86_400n, next_charge: BigInt(UP_NOW + 3_600), max_charges: 2n, fee_bps: 0n,
    });
    ix.apply(upEv("charged", [104n, SPENT_SUB, M_SPENT], {
      amount: 2_000_000n, fee: 0n, charges_made: 2n, next_charge: BigInt(UP_NOW + 86_400),
    }, "charge-104"));
    // A 60s period over 30 days is 43,200 occurrences: the cap kicks in.
    sub(105, FAST_SUB, M_FAST, {
      amount: 1_000n, period: 60n, next_charge: BigInt(UP_NOW + 60), max_charges: 0n, fee_bps: 0n,
    });
    // Two mandates with different rhythms, to check the merge order.
    sub(106, MIXED_SUB, M_WEEKLY, {
      amount: 3_000_000n, period: 604_800n, next_charge: BigInt(UP_NOW + 100), max_charges: 0n, fee_bps: 0n,
    });
    sub(107, MIXED_SUB, M_DAILY, {
      amount: 1_000_000n, period: 86_400n, next_charge: BigInt(UP_NOW + 200), max_charges: 0n, fee_bps: 0n,
    });

    await new Promise<void>((resolve) => {
      upServer = createApp(upDb, config).listen(0, () => {
        const addr = upServer.address();
        upBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  after(() => {
    upServer.close();
    upDb.close();
  });

  const upGet = async (path: string): Promise<{ status: number; body: UpcomingBody }> => {
    const res = await fetch(upBase + path);
    return { status: res.status, body: (await res.json()) as UpcomingBody };
  };

  test("a due mandate is projected from now, then every period", async () => {
    const { body } = await upGet(`/api/subscribers/${DUE_SUB}/upcoming`);

    assert.equal(body.subscriber, DUE_SUB);
    assert.equal(body.days, 30);
    assert.equal(body.until, body.now + 30 * 86_400);
    assert.equal(body.upcoming.length, 30);
    // The first charge is now — the keeper settles it on its next pass — not
    // the stale next_charge, and the hour it is late produces no catch-up.
    assert.equal(body.upcoming[0]!.mandateId, 101);
    assert.equal(body.upcoming[0]!.merchant, M_DUE);
    assert.equal(body.upcoming[0]!.at, body.now);
    assert.equal(body.upcoming[1]!.at, body.now + 86_400);
    assert.equal(body.totalUpcoming, "150000000"); // 5_000_000 × 30
    assert.equal(body.truncated, false);
    assert.equal(typeof body.upcoming[0]!.amount, "string");
    assert.ok(body.assumptions.length > 0);
  });

  test("a future mandate starts at its next_charge", async () => {
    const { body } = await upGet(`/api/subscribers/${FUTURE_SUB}/upcoming`);

    assert.equal(body.upcoming.length, 30);
    assert.equal(body.upcoming[0]!.at, UP_NOW + 3_600);
    assert.equal(body.upcoming[1]!.at, UP_NOW + 3_600 + 86_400);
    assert.equal(body.totalUpcoming, "60000000"); // 2_000_000 × 30
    assert.equal(body.truncated, false);
  });

  test("a capped mandate stops at its remaining allowance", async () => {
    const capped = await upGet(`/api/subscribers/${CAPPED_SUB}/upcoming`);
    // One of its two charges was made, so one remains even though 30 fit.
    assert.equal(capped.body.upcoming.length, 1);
    assert.equal(capped.body.upcoming[0]!.at, UP_NOW + 3_600);
    assert.equal(capped.body.totalUpcoming, "1000000");

    const spent = await upGet(`/api/subscribers/${SPENT_SUB}/upcoming`);
    assert.deepEqual(spent.body.upcoming, []);
    assert.equal(spent.body.totalUpcoming, "0");
  });

  test("a 60s period is capped per mandate and flagged", async () => {
    const { body } = await upGet(`/api/subscribers/${FAST_SUB}/upcoming`);

    assert.equal(body.upcoming.length, 400);
    assert.equal(body.truncated, true);
    assert.equal(body.upcoming[0]!.at, UP_NOW + 60);
    assert.equal(body.upcoming[399]!.at, UP_NOW + 60 + 399 * 60);
    assert.equal(body.totalUpcoming, "400000"); // 1_000 × 400 listed
  });

  test("charges from several mandates merge in time order", async () => {
    const { body } = await upGet(`/api/subscribers/${MIXED_SUB}/upcoming`);

    assert.equal(body.upcoming.length, 35); // 5 weekly + 30 daily
    assert.equal(body.upcoming[0]!.mandateId, 106); // weekly, +100s
    assert.equal(body.upcoming[1]!.mandateId, 107); // daily, +200s
    assert.equal(body.upcoming[1]!.at, UP_NOW + 200);
    assert.equal(body.upcoming[2]!.mandateId, 107);
    assert.equal(body.upcoming[2]!.at, UP_NOW + 200 + 86_400);
    const ats = body.upcoming.map((c) => c.at);
    assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
    assert.equal(body.totalUpcoming, "45000000"); // 3_000_000 × 5 + 1_000_000 × 30
  });

  test("days caps the window and malformed values fall back to 30", async () => {
    const one = await upGet(`/api/subscribers/${DUE_SUB}/upcoming?days=1`);
    assert.equal(one.body.days, 1);
    assert.equal(one.body.until, one.body.now + 86_400);
    assert.equal(one.body.upcoming.length, 1);
    assert.equal(one.body.upcoming[0]!.at, one.body.now);

    const long = await upGet(`/api/subscribers/${DUE_SUB}/upcoming?days=400`);
    assert.equal(long.body.days, 365);
    assert.equal(long.body.truncated, false);

    const malformed = await upGet(`/api/subscribers/${DUE_SUB}/upcoming?days=nope`);
    assert.equal(malformed.body.days, 30);
  });

  test("an unknown subscriber has nothing upcoming", async () => {
    const { status, body } = await upGet("/api/subscribers/GNOBODY/upcoming");
    assert.equal(status, 200);
    assert.deepEqual(body.upcoming, []);
    assert.equal(body.totalUpcoming, "0");
    assert.equal(body.truncated, false);
  });
});

describe("express 5 error boundary", () => {
  /** Listens on a random port and reports the base URL with a stop function. */
  async function serve(app: Express): Promise<{ url: string; stop: () => Promise<void> }> {
    const listener: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = listener.address();
    return {
      url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
      stop: () => new Promise<void>((resolve) => void listener.close(() => resolve())),
    };
  }

  test("an async handler rejection is answered 500, not left as an unhandled rejection", async () => {
    const reasons: unknown[] = [];
    const watch = (reason: unknown): void => {
      reasons.push(reason);
    };
    process.on("unhandledRejection", watch);

    const app = express();
    // Under Express 4 this rejection was swallowed: the caller's request hung
    // until it timed out and the failure surfaced on the process instead.
    // Express 5 awaits the handler and forwards the rejection to the boundary.
    app.get("/boom", async () => {
      throw new Error("rpc https://rpc.example/?token=KEEPER_SECRET exploded");
    });
    app.use(errorHandler);

    const srv = await serve(app);
    try {
      const res = await fetch(`${srv.url}/boom`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(res.status, 500);
      // The fixed shape also proves nothing of the message reached the caller.
      assert.deepEqual(await res.json(), { error: "internal_error" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(reasons, []);
    } finally {
      process.off("unhandledRejection", watch);
      await srv.stop();
    }
  });

  test("a failure raised inside the app's own middleware reaches the boundary", async () => {
    const app = createApp(db, config, status);
    const srv = await serve(app);
    // The boundary's own log line is captured instead of written, so the test
    // can assert what a log aggregator would have received.
    const lines: unknown[][] = [];
    mock.method(logger, "error", (...args: unknown[]): void => {
      lines.push(args);
    });
    try {
      // Truncated JSON: the body parser rejects asynchronously, so Express 5
      // hands the SyntaxError to the boundary instead of hanging the request.
      const res = await fetch(`${srv.url}/api/plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"KEEPER_SECRET":"do-not-log-me"',
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(res.status, 500);
      // Neither the parser's message nor any part of the request body leaks.
      assert.deepEqual(await res.json(), { error: "internal_error" });

      // pino is called as `logger.error(obj, msg)`; only the boundary's own
      // line is inspected, as a request line holds a live IncomingMessage.
      const boundary = lines.filter((args) => args[1] === "unhandled request error");
      assert.equal(boundary.length, 1);
      const logged = (boundary[0]![0] as { err: Error & { body?: unknown } }).err;
      assert.ok(logged);
      assert.equal(logged.name, "SyntaxError");
      // The parser hangs the raw body off its error; that must not survive.
      assert.equal("body" in logged, false);
      assert.ok(!logged.message.includes("do-not-log-me"));
      assert.ok(!(logged.stack ?? "").includes("do-not-log-me"));
    } finally {
      mock.restoreAll();
      await srv.stop();
    }
  });

  test("strips the caller's payload from the logged error", () => {
    // body-parser hangs the raw request body off its error, and pino would
    // serialize it as an own enumerable property of `err`.
    const err = Object.assign(new SyntaxError("Unexpected end of JSON input"), {
      body: '{"KEEPER_SECRET":"do-not-log-me"}',
      statusCode: 400,
      expose: true,
    });
    const kept = loggableError(err);
    assert.equal(kept.name, "SyntaxError");
    assert.equal(kept.message, "Unexpected end of JSON input");
    // The status is a number and survives; the payload does not.
    assert.equal((kept as Error & { status?: number }).status, 400);
    assert.equal("body" in kept, false);
    assert.equal("expose" in kept, false);
    assert.ok(!(kept.stack ?? "").includes("do-not-log-me"));
  });

  test("answers a fixed shape and never echoes the failure", () => {
    let code = 0;
    let sent: unknown;
    const res = {
      headersSent: false,
      status(status: number) {
        code = status;
        return this;
      },
      json(body: unknown) {
        sent = body;
        return this;
      },
    } as unknown as Response;

    errorHandler(
      new Error("mandate 7 rejected https://rpc.example/?token=KEEPER_SECRET"),
      {} as Request,
      res,
      () => {},
    );
    assert.equal(code, 500);
    assert.deepEqual(sent, { error: "internal_error" });
  });

  test("hands back a response whose headers are already out", () => {
    let forwarded: unknown;
    const res = {
      headersSent: true,
      status(): never {
        throw new Error("ERR_HTTP_HEADERS_SENT");
      },
      json(): never {
        throw new Error("ERR_HTTP_HEADERS_SENT");
      },
    } as unknown as Response;

    errorHandler(new Error("late failure"), {} as Request, res, (err?: unknown) => {
      forwarded = err;
    });
    assert.match(String((forwarded as Error).message), /late failure/);
  });
});
