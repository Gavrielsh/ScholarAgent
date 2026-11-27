# CLAUDE.md

Guidance for Claude Code when working in this repository.

ScholarAgent is an M.Sc. research system: a secure Agentic-RAG knowledge
assistant for Hebrew-language non-profit organizations, delivered over WhatsApp.
Its central claim is that **authorization must be enforced inside PostgreSQL,
not in application code or the system prompt**. Most conventions below exist to
protect that claim — changing them silently invalidates the thesis results in
`docs/experimental_results.md`.

---

## Commands

```sh
npm test                # jest — 230 tests across 20 suites, no DB or network needed
npx tsc --noEmit        # typecheck (CI runs this before lint and tests)
npm run lint            # next lint
npm run migrate         # apply migrations/*.sql in filename order
npm run dev             # Next.js app (webhook + upload routes)
npm run worker:whatsapp # BullMQ worker; must run alongside dev for chat to work
npm run ingest          # ingest local_data/documents (--base to point elsewhere)
npm run eval:seed       # plant canaries + run positive/negative RLS controls
npm run benchmark       # Experiment 1: retrieval arms R1-R4
npm run evaluate        # Experiment 2: 4 configs x 30 queries, end-to-end
npm run grade:qrels     # grade the pooled judgments
npm run reconcile       # repair documents whose chunks went missing
```

CI (`.github/workflows/ci.yml`) runs typecheck → lint → test on Node 20, then
builds both Docker images. The three check steps use `if: ${{ !cancelled() }}`
so one failure does not mask the others.

`docker compose up -d` starts **only** Postgres (pgvector/pgvector:pg16) and
Redis. The `app` and `whatsapp-worker` services sit behind the `full` profile.

---

## Module layout

Domain-driven, with dependencies flowing strictly inward:
`domain` → `security` → `core`. `core` depends on nothing above it, and nothing
in `core` encodes a business rule. Keep it that way — a `core` module that
imports from `domain` is a review-blocking defect.

```
app/api/                     Next.js App Router endpoints
  whatsapp/webhook/route.ts  Verify → claim → enqueue → ACK. Nothing else.
  upload/route.ts            Authenticated document upload
  webhooks/document-deleted/ Drive deletion fan-in

lib/core/                    Technology-facing infrastructure, no business rules
  db.ts                      Pools, RLS transactions, hybrid retrieval, RRF
  db/accessLevel.ts          AccessLevel 0..3 — dependency-free tier contract
  queue.ts                   BullMQ connection, deadline race, attempt accounting
  redis.ts                   Redis client + the webhook idempotency claim
  telemetry.ts               Langfuse tracing, RAGAS scoring, DLS computation
  irMetrics.ts               Recall@k, MRR, NDCG for the retrieval benchmark
  logger.ts  env.ts  http/fetchWithTimeout.ts

lib/security/                Cross-cutting, enforced independently of any domain
  auth.ts                    Four-tier RBAC, user registry, phone normalization
  crypto.ts                  Meta HMAC-SHA256 verification, timing-safe compare
  guardrails.ts              PII redaction, distress handoff, privacy screens
  extractUser.ts             JWT identity extraction

lib/domain/
  chat/     agent.ts (intent routing + admin handlers), rag.ts (baseline RAG),
            llm.ts (all four providers), rerank.ts, knowledgeGaps.ts,
            state.ts (ChatMessage leaf), session/
  ingestion/pipeline.ts, embeddings.ts, retrieval.ts, retrievalArms.ts, worker.ts
  whatsapp/ webhook.ts (parsing/safety), worker.ts (the real work), client.ts, types.ts
  admin/    auditLogs.ts

migrations/                  001 baseline + RLS role/grants/policies, 002 knowledge gaps, 004, 005, run.ts
scripts/                     Operational entry points, snake_case, via `node --import tsx`
local_data/eval_corpus/      15-document L0/L1/L2 synthetic corpus for the thesis
docs/                        Research proposal, empirical results, demo runbook
```

Two placements are deliberate and have bitten before:

- **`lib/domain/chat/state.ts`** holds only `ChatMessage`. Folding it into
  `agent.ts` creates an `agent → rag → agent` import cycle.
- **`lib/domain/whatsapp/worker.ts`** owns the queue *and* the handler. Only
  generic plumbing lives in `lib/core/queue.ts`.

Imports use the `@/` alias (`tsconfig.json` paths, mirrored in
`jest.config.js` `moduleNameMapper`). Use it rather than deep relative paths.

---

## RLS role enforcement — the load-bearing invariant

`migrations/001_initial_schema.sql` enables and FORCEs row-level security on
`knowledge_base`, `ingested_documents` and `chat_history`. By design that is
**not enough on its own**: in PostgreSQL any role with `rolsuper` or
`rolbypassrls` skips every policy regardless of `FORCE`, and the connecting
role usually is one — the Postgres Docker entrypoint always creates
`POSTGRES_USER` as a superuser, and a managed database's app role may be
privileged too. So identity is separated up front (defense in depth): the
connecting role is only the owner/migrator and never serves a request, while
every request runs as the least-privilege `scholaragent_app`.

The role, grants, `ENABLE`/`FORCE` RLS and policies live together in
`migrations/001_initial_schema.sql`, in dependency order (tables → role →
grants → ENABLE + FORCE → policies → self-check):

```sql
CREATE ROLE scholaragent_app
  NOLOGIN NOSUPERUSER NOBYPASSRLS
  NOCREATEDB NOCREATEROLE NOREPLICATION;
```

`NOLOGIN` is intentional — nothing connects as this role. It is entered
*inside* a transaction, in `lib/core/db.ts`:

```ts
await client.query("BEGIN");
// GUC first, while the connecting role is still in effect…
await client.query("SELECT set_config('app.user_permission_level', $1, true)", [...]);
await enterAppRole(client);   // …then SET LOCAL ROLE scholaragent_app
```

Rules that follow from this, all of which matter:

- **Order is fixed.** The GUC is set while still in the connecting role, then
  the role switch happens. Do not reorder.
- **`SET LOCAL` is transaction-scoped.** It reverts on `COMMIT` and `ROLLBACK`,
  so one user's tier can never leak onto the next user of a pooled connection.
- **`enterAppRole` fails closed** (`lib/core/db.ts:207`). If the role is missing
  — migration 001 was not applied — the transaction throws rather than running
  as superuser with every policy bypassed. Never "handle" this error by
  continuing; that silently disables the whole control.
- **`assertSqlIdentifier`** (`lib/core/db.ts:189`) is the injection boundary.
  `SET LOCAL ROLE` takes an identifier, so `PG_APP_ROLE` is interpolated, not
  bound. It is exported purely so it can be tested directly
  (`lib/core/db.identifier.test.ts`).
- **Migration 001 self-checks** (§10). A `DO` block raises if the role holds
  `SUPERUSER`/`BYPASSRLS` or if `FORCE ROW LEVEL SECURITY` is off on any of the
  three tables, so a database cannot be stamped "secured" while it is not.
- **The GUC names are `app.user_permission_level` and `app.sender_id`.** There
  is no `app.current_tier`. Lower number = more privileged (0 = Admin,
  3 = Volunteer); a row is visible when caller level ≤ row classification.

### The one escape hatch

`withServiceClient` (`lib/core/db.ts:158`) uses a separate pool and never
switches role, so it reads across every classification level. It exists for one
reason: the evaluation harness's **positive control**. Proving a canary is
retrievable at all is what makes a later 0% leakage result mean anything.
It must never be reachable from a user-facing path. `npm run eval:seed` exits
non-zero if either its positive or negative control fails.

### Adding a table that holds tier-sensitive rows

Migration 001's GRANTs and `ALTER DEFAULT PRIVILEGES` (§8) cover future tables only
when applied by the same role. A new migration adding a sensitive table must
itself `ENABLE` + `FORCE ROW LEVEL SECURITY`, write its own policies, and re-run
the GRANT block. `knowledge_gaps` (migration 002) deliberately has neither.

---

## Transient retry in `lib/domain/chat/llm.ts`

All four providers (mock, OpenAI, Gemini, Claude) speak raw HTTP through
`fetchTextWithTimeout` — this repo depends on no vendor SDK. API keys are read
inside `generateText()`, never at module scope, so importing the module reads no
credentials and opens no connection.

`fetchLlmWithRetry` wraps every provider call:

- **Retries** HTTP 429, any 5xx, and our own timeout.
- **Never retries a 4xx** other than 429 — those are deterministic.
- **Backoff `[500, 1500]` ms**, i.e. 2 retries and ≤2s total. Deliberately
  small: the chat job's deadline is 90s (`WHATSAPP_JOB_TIMEOUT_MS`), and a
  throttle blip must not consume it.
- **Honours the abort signal** — a caller that gave up is not retried into.
- **Returns the final response as-is**, including a non-2xx, once attempts are
  exhausted. Every call site keeps its own `!response.ok` handling and error
  message unchanged from before the retry existed. Preserve that contract.
- Each retry logs `llm_call_retry` with label, attempt and delay.

Before this, a single 429 failed the whole BullMQ attempt and paid its
exponential backoff — tens of seconds — for a blip a 500ms retry absorbs. The
same rule already governs Gemini embedding calls in
`lib/domain/ingestion/embeddings.ts`; keep the two consistent.

---

## The WhatsApp webhook ACKs without blocking

`app/api/whatsapp/webhook/route.ts` does the absolute minimum before returning
200, because Meta redelivers anything it does not see ACKed within a few
seconds. The order is fixed:

1. Verify `X-Hub-Signature-256` against the **raw body bytes** (403 on invalid).
2. Drop status-only and unroutable payloads with a 200.
3. Claim the message id with a single Redis `SET NX` — the idempotency guard.
4. Enqueue to the queue that owns the delivery kind.
5. For documents only, **fire-and-forget** the "received, queued" receipt.
6. ACK.

Step 5 is the non-blocking part and the reason it is safe:

```ts
if (delivery.kind === "document") {
  void sendQueuedReceipt(senderId, messageId);   // fired, not awaited
}
```

`sendWhatsAppTextMessage` retries up to 5 times with backoff, which can run for
tens of seconds. Awaiting it would add up to `RECEIPT_TIMEOUT_MS` (default
2500ms) of pure latency to the ACK, and a slow receipt would turn into a Meta
redelivery of a document already on the queue. `sendQueuedReceipt` swallows its
own errors on every path, so the un-awaited call can never surface as an
unhandled rejection — **do not remove that try/catch**. This is sound only
because the route runs as a long-lived Node process (`runtime = "nodejs"`, one
container per compose service), not on a runtime that freezes after `return`.

Chat messages intentionally skip the receipt: the worker's read receipt and
typing indicator already cover it.

**Nothing that touches Postgres or an LLM belongs in this file.** The RBAC gate
is a database round trip, so it lives in the ingestion worker (`authorizeSender`
in `lib/domain/ingestion/pipeline.ts`). A consequence worth knowing: an
unauthorized sender receives the queued-receipt first and the permission error
second.

Two deliberate non-200s: Redis unavailable at claim time, and enqueue failure
(which also releases the claim). Both return 503 so Meta's redelivery acts as
the durability mechanism. Do not "fix" these into 200s.

---

## Tests

`npm test` is the baseline: **230 tests, 20 suites, all passing**, in roughly
two seconds. The suite needs no database, no Redis and no network — every
external dependency is faked. Keep it that way; a test that needs
`docker compose up` will not run in CI.

```
lib/core/             db.identifier, db.lexical, irMetrics, queue, telemetry
lib/security/         crypto, guardrails
lib/domain/chat/      agent, knowledgeGaps, rerank
lib/domain/ingestion/ pipeline, worker
lib/domain/whatsapp/  webhook, worker
scripts/              grade_qrels, data/golden_dataset
```

Test files sit next to the code they cover (`*.test.ts`). When changing
anything in the RLS path, the webhook ACK path, or the retry path, add to the
existing suite rather than starting a new one — the file boundaries match the
module boundaries on purpose.

---

## Conventions and gotchas

- **Hebrew is the user-facing language.** Error strings, receipts and system
  prompts in `app/` and `lib/domain/` are Hebrew. Code, comments and docs
  (except `docs/experimental_results.md`) are English.
- **`.env.local`, not `.env`.** The Next.js app and every script call
  `dotenv.config({ path: ".env.local" })` explicitly. A plain `.env` is ignored.
- **Scripts are snake_case; library modules are camelCase.** Scripts run via
  `node --import tsx`, so they resolve `__dirname` and `import.meta`
  defensively — copy that pattern rather than picking one.
- **`migrations/002_knowledge_gaps.sql` does not stamp itself**, so it
  re-applies on every `npm run migrate`. It is idempotent, so this is harmless,
  but do not assume `schema_migrations` reflects it. New migrations **must** end
  with their own `INSERT INTO schema_migrations … ON CONFLICT DO NOTHING`, as
  001 does.
- **Numbering jumps 002 → 004 intentionally.** The RLS role/grants migration
  that was once 003 is now folded into 001, and the numbers were not reused.
- **Retrieval arms share one code path.** All four arms in
  `lib/domain/ingestion/retrievalArms.ts` go through the same `executeRetrieval`
  in `lib/core/db.ts` and differ only by `strategy`; the query embedding is
  computed once and shared. That de-confounding is what makes the benchmark
  comparable — do not give an arm its own retrieval path or its own embedding.
- **Re-rank filtering never uses the `similarity` column.** It holds
  `1 − cosine` for dense rows and `ts_rank_cd` for lexical rows, which share no
  scale. Filter on re-rank scores or `rrfScore` only
  (`lib/domain/chat/rerank.ts`).
- **Default models**: `claude-sonnet-4-6` (`llm.ts:312`) and `gemini-3.5-flash`
  (`llm.ts:249`), overridable via `CLAUDE_MODEL` / `GEMINI_MODEL`.
  `LLM_PROVIDER` defaults to `mock`.

---

## Changing anything security-relevant

Before touching `lib/core/db.ts`, `lib/security/`, `migrations/`, or the webhook
route, read `docs/experimental_results.md` §2 and §5. The 0.00% retrieval
leakage result across all 60 secured runs is the project's central finding, and
it rests on the exact mechanism described above. If a change alters that
mechanism, the results document and `docs/demo_runbook.md` need updating in the
same change — not later.
