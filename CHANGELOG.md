# Changelog

All notable changes to payflow-backend. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added
- **Zero-downtime keeper key rotation (#71).** The keeper accepts a standby
  key in `KEEPER_SECRET_NEXT`: if the active key's source account is unusable
  it rotates mid-pass and retries the same mandate, and after a pass settles
  with the new key it logs that the previous key can be retired. Secrets are
  reloaded on `SIGHUP` (`.env` re-read, config re-validated) so promotion of
  the standby needs no restart. Tested by swapping keys between passes.
- **Typed API client (#72).** `src/client/index.ts` is a small typed fetch
  client for every endpoint, returning the same response types the route
  handlers annotate their bodies with (`src/routes/types.ts`) — shared, not
  copied. Exposed as the `payflow-backend/client` subpath after `npm run
  build` and tested against the HTTP test server.
- **Spec-driven event decoding (#73).** Event shapes live in the committed
  contract spec `src/lib/event_spec.json`. The indexer validates every
  decoded event before projecting it: mismatches (renamed fields, wrong
  types, extra data or topics) are logged with the exact problems, counted
  per pass in `TickResult.mismatched` and in `/health`'s
  `indexer.mismatchedEvents`, and never stored as zeros.
- **`arr` on the merchant summary.** `/api/merchants/:address/summary` now
  reports annual recurring revenue next to `mrr`: every active mandate
  normalised to a 365-day year. Both formulas are documented in the README.
- **Parallel window backfill (#59).** The indexer fetches up to
  `INDEXER_FETCH_CONCURRENCY` (default 4, max 16) 8,000-ledger windows at
  once and applies them in ledger order. The cursor advances only after a
  window is applied, so a failed later window resumes at the last applied
  one; `1` restores strictly sequential reads.
- **Batch mandate lookup (#61).** `/api/mandates?ids=1,2,3` returns up to 100
  mandates in one request. Unknown ids are omitted, more than 100 ids is
  `400 too_many_ids`, and a non-numeric id is `400 invalid_ids`. The typed
  client's `MandatesQuery` gained `ids`.
- **SQL template lint rule (#65).** ESLint rejects `prepare()` calls whose
  SQL is an interpolated template literal. Vetted static fragments carry an
  explained `eslint-disable-next-line` comment, and a test runs the real
  config against a deliberately bad query to prove the rule fires.
- **Volume and fee statistics (#55).** `/api/stats` reports 24-hour and all-time
  charge volume (gross: net amount plus protocol fee), total fees and the
  number of merchants with an active mandate, alongside the existing counts.
  Amounts are decimal strings.
- **RPC endpoint failover (#60).** `SOROBAN_RPC_URL` now accepts a comma-separated
  list. Calls go to the active endpoint and switch to the next when one fails;
  a health probe prefers the endpoint with the freshest ledger, so a reachable
  but lagging node does not hold the indexer back either. `/health` reports the
  active endpoint and the full list under `rpc`.
- **`/api/subscribers/:address/upcoming` (#62).** Projects each active mandate's
  charges over the next `days` (default 30, capped at 365), following the
  contract's scheduling rule — a due mandate at `now`, a future one at its
  `next_charge`, then every `period` — and stops at a mandate's remaining
  `max_charges` allowance. Each entry is the gross per-charge the subscriber
  pays, with the projected time; `truncated` flags the per-mandate cap.
- **`/ready` readiness probe (#58).** Answers 503 (`starting`, then `catching_up`)
  until the indexer's projection trails the network by no more than 120
  ledgers, so orchestrators do not route traffic to an instance that is still
  backfilling. `/health` stays a liveness probe answering 200.
- **Merchant revenue forecast (#63).** `/api/merchants/:address/forecast` projects
  the charges a merchant's active mandates will produce over the next `days`
  (default 30, capped at 365), each occurrence net of the mandate's fee, and
  returns the window and assumptions it used.
- **Token-protected `/admin` operator endpoints (#64).** Trigger an indexer pass,
  run a keeper pass, or read the keeper's backoff list. They exist only when
  `ADMIN_TOKEN` is set, require `Authorization: Bearer`, and the token is
  compared in constant time. Triggered passes queue behind any pass already
  running rather than overlapping it.

### Changed

- **Summary query indexes (#66).** Covering indexes for the merchant and
  subscriber summary aggregates (`mandates(merchant, status, period, amount)`,
  `charges(merchant, amount)`, `charges(subscriber, amount, fee)`) are added
  through the startup migration, so existing databases gain them without a
  rebuild. `EXPLAIN QUERY PLAN` now reports covering-index searches instead
  of table lookups.

- **One router per resource (#74).** `src/routes/index.ts` is split into
  `plans.ts`, `mandates.ts`, `merchants.ts`, `subscribers.ts` and `stats.ts`
  with shared query helpers in `helpers.ts`. No change in behaviour: paths,
  query handling and response shapes are identical and the existing API
  tests pass unchanged.

- **Express 5 (#77).** `express` and `@types/express` move to 5.x. No removed
  API was in use — no `app.del`, no `res.send(status)`, no wildcard or
  regex paths for path-to-regexp v8 to reject — so routes and response shapes
  are untouched and payflow-frontend needs no migration note. What does change
  is where a failure lands: Express 5 awaits a handler's result and forwards a
  rejected promise to the error middleware, so an `async` route no longer needs
  a manual `try`/`catch` to avoid leaving the caller hanging with an unhandled
  rejection. The four-argument handler in `src/app.ts` is now the single
  boundary for every failure, is exported as `errorHandler`, hands back errors
  whose response has already started, and logs `loggableError(err)` (type,
  message, status, stack) instead of the raw error — `body-parser` hangs the
  caller's request body off its `SyntaxError`, and that must not reach a log
  line.

### Fixed

- **Merchant totals no longer mix tokens (#56).** `/api/merchants/:address/summary`
  summed every charge into one figure even when the merchant's plans used
  several tokens. Revenue and MRR are now also grouped per token in a `tokens`
  array, and the flat fields report the default token (`TOKEN_ID`) when one is
  configured — without one they keep their previous all-token meaning.

## [0.2.0] - 2026-10-09

Points at the v0.2.0 contract suite on testnet.

### Fixed

- **The keeper could stall behind failing mandates.** Every pass retried the
  25 oldest due mandates first, so 25 underfunded vaults blocked every other
  mandate indefinitely. A failed charge now backs off (1 minute, doubling, up
  to 6 hours) and a success clears it.
- **Passes could overlap.** Indexer and keeper ran on `setInterval`, so a pass
  slower than the interval ran alongside the next one. Overlapping indexer
  passes could move the cursor backwards; overlapping keeper passes submitted
  transactions with the same sequence number. Each loop now waits for its pass
  to finish.
- **A fresh indexer saw only the last ~11 hours.** With no cursor it started
  8,000 ledgers back. It now starts at `INDEXER_START_LEDGER` or, if unset, the
  oldest ledger the RPC node serves, and moves a cursor that fell out of
  retention forward instead of failing.
- **Ranges could end early.** A page with fewer than 200 events was taken to
  mean the range was exhausted. Paging now continues until a page is empty or
  passes the end of the range, which is passed to RPC as `endLedger`.
- **`npm run indexer` indexed one window and exited.** It now runs until it has
  caught up.
- **`npm run lint` could not run**: ESLint was not installed. ESLint 9 with
  typescript-eslint is configured and CI enforces it.
- **The Render blueprint could not deploy on the free plan**, which has no
  persistent disk. It now rebuilds the projection from the deployment ledger.

### Added

- `mandate_ended` events (a merchant ending a mandate) are projected as
  `Cancelled`, and mandates record who ended them in `ended_by`.
- `/health` reports `starting`, `ok` or `catching_up`, the indexer cursor, its
  lag behind the network, and the last error.
- A scheduled GitHub Actions keeper that settles due testnet mandates without
  an always-on server.

### Changed

- `@stellar/stellar-sdk` 13 → 17, for testnet's current protocol.
- 24 → 39 tests, including indexer sync against a fake RPC node, keeper
  backoff, and loop overlap.

## [0.1.0] - 2026-09-02

Event indexer, settlement keeper and read API for the first testnet
deployment.

[0.2.0]: https://github.com/MMM-pay/payflow-backend/releases/tag/v0.2.0
