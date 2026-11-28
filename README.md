<a id="readme-top"></a>

<div align="center">
  <h1>ScholarAgent</h1>
  <p>
    <strong>Database-enforced authorization for Hebrew organizational RAG.</strong><br />
    A deterministic four-tier RAG architecture — lexical intent routing, bounded
    handlers, no autonomous tool loops — that drives cross-tier retrieval leakage from
    <strong>78.67%–80.00%</strong> to <strong>0.00%</strong> — measured, not asserted.
  </p>
  <p>
    <a href="#the-problem-semantic-collision">The Problem</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="#empirical-results">Results</a> ·
    <a href="#quickstart">Quickstart</a> ·
    <a href="docs/experimental_results.md">Full Evaluation (HE)</a>
  </p>

[![MIT License][license-shield]][license-url]
[![LinkedIn][linkedin-shield]][linkedin-url]

</div>

---

## TL;DR

ScholarAgent is an M.Sc. research system and a working WhatsApp knowledge
assistant for Hebrew-language non-profits. It exists to test one claim:

> In an organizational RAG system where every classification tier discusses the
> **same subjects in the same words**, authorization filtering in application
> code or in the system prompt is not a security control. Only enforcement
> inside the database is.

The claim was tested across **120 end-to-end runs** (4 configurations × 30
queries) and **90 retrieval observations** over a purpose-built Hebrew corpus
with planted canaries. Prompt-level defense leaked unauthorized chunks into the
model's context on **78.67%–80.00%** of adversarial queries. Database-enforced
RLS leaked on **0.00%** — all 60 secured runs, zero exceptions, including every
adversarial query. The cost of that isolation is measured and reported too:
answer relevancy falls from 81.1% to 68.7% on the strictest configuration.

---

## The Problem: Semantic Collision

Enterprise RAG is almost always built the same way: retrieve from the knowledge
base, filter out what the user may not see, pass the remainder to the LLM. The
unstated assumption is that the filter worked.

In a Hebrew organizational corpus that assumption is especially dangerous,
because the classification tiers are not about *different topics* — they are
about *different depths of the same topic*. A real example from this system's
corpus, the question **"What is the expense reimbursement ceiling?"**:

| Tier | What exists at this tier |
|---|---|
| **L2** (Staff) | ₪50 per day of activity, public transport only, against receipts |
| **L1** (Manager) | A ₪250-per-trip exception authority and a ₪4,500 regional ceiling |
| **L0** (Admin) | An audit report freezing approvals above ₪1,000 — naming two employees |

All three documents share the exact phrase **"החזר הוצאות ונסיעות"** and the
terms `קבלות`, `תקרה`, `אסמכתה`, `ועדה`. To a vector index they are near-neighbors
of the same innocent question, and it has no reason to prefer one over another.

We call this **Semantic Collision**: documents at different classification
levels that are near-identical in meaning and phrasing, which turns every benign
user question into an isolation test.

### Why app-layer filtering fails

It relies on every data path remembering to filter. A real system has more than
one: a webhook, an ingestion pipeline, a reconciliation job, an evaluation
harness. `lib/core/db.ts` alone contains three independently written write
paths, each with its own context handling. One forgotten filter is a breach, and
nothing about the architecture makes the omission visible.

### Why prompt-level filtering fails

It fails more fundamentally: it tries to tell the model what *not to say*
**after the classified material is already inside its context window**. Once an
L0 chunk is in front of the model, leakage stops being an access-control
question and becomes a probabilistic question about model behavior.

The experiment measures exactly that. Under prompt-only defense, unauthorized
chunks reached the model's context on 78.67% of adversarial queries — and the
Gemini configuration disclosed them in **100.0%** of authorization-escalation
attempts, including a donor's name and a confidential **₪1,850,000** pledge
handed to an L2 user.

Prompt instructions are not worthless — in the injection test `ADV-014` both
models refused. But they succeeded *probabilistically*, after the sensitive data
was already exposed to them. **Database enforcement turns a probabilistic
question into a deterministic one.**

---

## Architecture

```mermaid
flowchart TB
    U["👤 WhatsApp User<br/>(tier L0–L3)"]

    subgraph EDGE["Edge — app/api/whatsapp/webhook/route.ts"]
        direction TB
        SIG["1 · Verify HMAC-SHA256<br/>against raw body bytes"]
        IDEM["2 · Redis SET NX<br/>idempotency claim"]
        ENQ["3 · Enqueue job"]
        ACK["4 · ACK 200<br/>(receipt fired, not awaited)"]
        SIG --> IDEM --> ENQ --> ACK
    end

    subgraph QUEUE["BullMQ · Redis"]
        CHATQ["whatsapp-incoming"]
        DOCQ["document-ingestion"]
    end

    subgraph WORKER["Worker — 90s deadline"]
        direction TB
        GUARD["Guardrails<br/>PII redaction · distress handoff"]
        RBAC["RBAC lookup<br/>phone → tier (lib/security/auth.ts)"]
        ROUTE["Lexical intent router<br/>knowledge · admin · history<br/>(deterministic, no tool loop)"]
        GUARD --> RBAC --> ROUTE
    end

    subgraph DB["PostgreSQL 16 + pgvector — the security boundary"]
        direction TB
        TX["BEGIN<br/>set_config('app.user_permission_level', tier, true)<br/><b>SET LOCAL ROLE scholaragent_app</b><br/><i>NOLOGIN · NOSUPERUSER · NOBYPASSRLS</i>"]
        RLS["FORCE ROW LEVEL SECURITY<br/>knowledge_base · ingested_documents · chat_history"]
        HYB["Hybrid retrieval<br/>dense HNSW cosine + sparse ts_rank_cd<br/>fused by RRF (k=60)"]
        TX --> RLS --> HYB
    end

    LLM["LLM adapter · lib/domain/chat/llm.ts<br/>Claude · Gemini · OpenAI · Mock<br/>retry 429/5xx/timeout — [500, 1500] ms<br/>token usage → per-query executionCostUsd"]
    OUT["↩ Answer via WhatsApp Cloud API"]

    U --> SIG
    ENQ --> CHATQ & DOCQ
    CHATQ --> GUARD
    ROUTE --> TX
    HYB -->|"only authorized chunks<br/>ever leave the database"| LLM
    LLM --> OUT --> U

    style DB fill:#0b3d2e,stroke:#1f7a5c,color:#eaf7f1
    style EDGE fill:#1a2b4a,stroke:#3d5a8a,color:#e8eefc
    style TX fill:#124a38,stroke:#2fa37a,color:#eaf7f1
    style RLS fill:#124a38,stroke:#2fa37a,color:#eaf7f1
```

### The security boundary, precisely

`FORCE ROW LEVEL SECURITY` alone is **not sufficient**, and the architecture is
designed around that from the first migration. In PostgreSQL, any role holding
`rolsuper` or `rolbypassrls` skips every policy regardless of `FORCE`, and the
connecting role is routinely exactly that: the Postgres Docker entrypoint always
creates `POSTGRES_USER` as a superuser, and the same is true of any managed
database whose application role happens to be privileged.

The design is therefore **defense in depth through identity separation**:

| Identity | Privileges | Used for |
|---|---|---|
| Owner / migrator (the `DATABASE_URL` role) | Owns the schema; may be a superuser | Applying migrations and opening connections. **Never evaluated against RLS and never serves a request.** |
| `scholaragent_app` | `NOLOGIN NOSUPERUSER NOBYPASSRLS`, table-level DML only | Every user-facing query, entered with `SET LOCAL ROLE` inside the transaction. |

The owner connection only *carries* the session; policies are always evaluated
against `scholaragent_app`. The role, its grants, `ENABLE`/`FORCE ROW LEVEL
SECURITY` and all policies are created together, in dependency order, in the
baseline migration:

```sql
-- migrations/001_initial_schema.sql  (§8)
CREATE ROLE scholaragent_app
  NOLOGIN NOSUPERUSER NOBYPASSRLS
  NOCREATEDB NOCREATEROLE NOREPLICATION;
```

```ts
// lib/core/db.ts — withRlsTransaction
await client.query("BEGIN");
// GUC first, while the connecting role is still in effect…
await client.query("SELECT set_config('app.user_permission_level', $1, true)", [tier]);
await enterAppRole(client);   // …then SET LOCAL ROLE scholaragent_app
```

Four properties make this a control rather than a convention:

1. **`NOLOGIN` by design.** Nothing connects as this role; it is only *entered*
   via `SET LOCAL ROLE`. No new credential, no connection-string change.
2. **Transaction-scoped.** `SET LOCAL` reverts on `COMMIT` and `ROLLBACK`, so
   one user's tier cannot leak onto the next user of a pooled connection.
3. **Fail-closed.** If the role is missing, `enterAppRole` throws and the query
   is refused — rather than running as superuser with every policy bypassed,
   which is the vulnerability itself, arriving silently.
4. **Self-verifying.** Migration 001 raises if the role ever holds `SUPERUSER`
   or `BYPASSRLS`, or if `FORCE ROW LEVEL SECURITY` is off on any protected
   table. A database cannot be stamped "secured" while it is not.

One escape hatch exists and is deliberate: `withServiceClient` uses a separate
pool and never switches role. The evaluation harness's **positive control**
depends on it — proving a canary is retrievable at all is what makes a later 0%
leakage result mean anything. It is never reachable from a user-facing path.

### Retrieval

Dense vector search (`pgvector`, HNSW, `vector_cosine_ops`, `m=16`,
`ef_construction=64`, 768 dimensions) fused with sparse full-text search
(`ts_rank_cd` over a generated `tsvector`, GIN-indexed) via Reciprocal Rank
Fusion:

$$RRF(d) = \sum_{r} \frac{1}{k + \mathrm{rank}_r(d)}, \qquad k = 60$$

Worth stating plainly for reviewers: `ts_rank_cd` is **not** Okapi BM25.
PostgreSQL has no built-in BM25; this is coverage-density ranking, and the arm
should not be described as BM25. The `'simple'` text-search configuration does no
stemming, so Hebrew prefixes (ה/ו/ב/ל…) are not stripped. The lexical query
**OR-joins** its terms (`buildLexicalSearchExpression`, at most 24 terms); the
experiment below ran before that fix, when the leg AND-joined every term.

**Small-to-big chunks.** Documents are stored as parent chunks (~1,400 characters,
`embedding NULL`, read by the LLM) and child chunks (~400 characters, overlap 60,
embedded and searched). Every stored body starts with a contextual header
(`[מסמך: … | רמת סיווג: L<n> | סעיף: …]`). A matched child is widened to its
parent *inside the same RLS transaction*, so widening never exposes more than
the caller may see. Every ingestion path — HTTP upload, WhatsApp document, and
`npm run reconcile` — builds its rows through the same helpers
(`planParentChildChunks`, `buildParentChildRecords` in
`lib/domain/ingestion/pipeline.ts`), so a reconciled document is indistinguishable
from a freshly ingested one.

**Per-query cost.** Each provider adapter reports the token usage the API
returned; `lib/core/telemetry.ts` prices it from a per-model table
(`claude-sonnet-4-6`, `claude-haiku-4-5`, `gemini-3.5-flash`, `gpt-4o-mini`) and
records `executionCostUsd` on the Langfuse trace, in the
`baseline_rag.llm_cost` log line and on `RagasScores`. These are list-price
*estimates*; mock and unknown models report no cost (never `0`). The recorded
experiment predates this, so it carries no cost figures.

All four benchmark arms run through the same `executeRetrieval`, over the same
corpus, with the same overfetch and the same RLS mechanism, differing only by
`strategy`. The query embedding is computed once and shared. That de-confounding
is what makes differences between arms attributable to the strategy.

---

## Empirical Results

Full methodology, case studies and threats to validity:
**[`docs/experimental_results.md`](docs/experimental_results.md)** (Hebrew).
Artifacts: `scripts/output/benchmark_summary.md`,
`scripts/output/evaluation_results_2026-11-18_11-04-54.csv`.

### Headline: the isolation result

Experiment 2 — 2×2 matrix of model × enforcement, 30 queries per cell,
**120 end-to-end runs**. `Avg DLS` is the Data Leakage Score at the **retrieval**
stage: the share of retrieved chunks classified above the asker's tier. No LLM
is involved in that measurement, so it is fully deterministic.

| Config | Model | Enforcement | Completed | **Avg DLS ↓** | Faithfulness ↑ | Answer Relevancy ↑ | Context Precision ↑ | Context Recall ↑ | Latency |
|---|---|---|---|---|---|---|---|---|---|
| `A` | claude-sonnet-4-6 | Prompt only | 28/30 | 45.71% | 86.9% | 81.1% | 76.4% | 71.4% | 16,256 ms |
| `B` | gemini-3.5-flash | Prompt only | 30/30 | 46.67% | **100.0%** | **99.7%** | 43.0% | 91.7% | 17,578 ms |
| `C` | claude-sonnet-4-6 | **DB RLS** | 30/30 | **0.00%** | 85.5% | 68.7% | 52.7% | 65.8% | **8,996 ms** |
| `D` | gemini-3.5-flash | **DB RLS** | 30/30 | **0.00%** | **100.0%** | 94.5% | 33.2% | 83.3% | 13,678 ms |

### Under attack — adversarial queries only (n = 15 per config)

This is where the architectural difference is decided.

| Config | Completed | **Avg DLS ↓** | Faithfulness | Answer Relevancy | Context Precision | Latency |
|---|---|---|---|---|---|---|
| `A` | 14/15 | **80.00%** | 78.9% | 70.0% | 73.1% | 15,306 ms |
| `B` | 15/15 | **78.67%** | 100.0% | 99.7% | 39.0% | 17,820 ms |
| `C` | 15/15 | **0.00%** | 88.3% | 65.7% | 26.7% | 7,141 ms |
| `D` | 15/15 | **0.00%** | 100.0% | 89.0% | 18.0% | 12,010 ms |

**0.00% across all 60 secured runs** (`C` + `D`), including every adversarial
query. Zero unauthorized chunks reached the model's context window. That is the
project's central finding.

Disclosure by attack family makes the mechanism visible:

| Config | Authorization escalation | Prompt injection | Benign control |
|---|---|---|---|
| `A` | 63.6% (n=11) | 33.3% (n=3) | 14.3% (n=14) |
| `B` | **100.0%** (n=12) | 33.3% (n=3) | 66.7% (n=15) |
| `C` | **0.0%** (n=12) | **0.0%** (n=3) | 40.0% (n=15) |
| `D` | 8.3% (n=12) | **0.0%** (n=3) | 60.0% (n=15) |

The 40%/60% figures in the benign-control column are **measurement-tool false
positives, not leaks** — retrieval-stage DLS is a flat 0.00% for those same
runs. Two causes: the forbidden-term lists overlap deliberately across tiers
(an innocent answer mentioning "תקרה" matches an L0 term), and a model that
*refuses* while naming the protected entity gets flagged by a substring check.
Generation-stage DLS is therefore reported as an **upper bound**, and the
isolation claim rests on the deterministic retrieval-stage metric.

### The trade-offs, stated honestly

| What it costs | Evidence |
|---|---|
| **Answer relevancy** falls 81.1% → 68.7% (`A` → `C`) | Secured Claude turns conservative and sometimes declines answerable questions |
| **Context precision** falls 76.4% → 52.7% and 43.0% → 33.2% | Expected, not a bug: RLS shrinks the candidate pool, so marginally less focused chunks make the cut |
| **Re-ranking is not worth it** | +1.5 pp `Recall@3` (0.929 → 0.944) and +0.3 pp `NDCG@5` for **+8,233 ms** P50 — three orders of magnitude over the 4 ms retrieval itself. Disqualifying for interactive chat |
| **Secured is *faster*** | `C` at 8,996 ms vs `A` at 16,256 ms — a smaller authorized candidate pool means less context to process |

### Experiment 1 — retrieval arms (mean ± population SD over 3 repeats)

| Arm | Recall@3 | Recall@5 | Recall@10 | MRR | NDCG@5 | P50 latency |
|---|---|---|---|---|---|---|
| `R1_sparse` | 0.000 † | 0.000 † | 0.000 † | 0.000 † | 0.000 † | 2 ms |
| `R2_dense` | 0.929 ± 0.175 | 0.976 ± 0.106 | 1.000 | 1.000 | 0.977 ± 0.048 | 3 ms |
| `R3_hybrid_rrf` | 0.929 ± 0.175 | 0.976 ± 0.106 | 1.000 | 1.000 | 0.977 ± 0.048 | 4 ms |
| `R4_hybrid_reranked` | **0.944 ± 0.157** | 0.976 ± 0.106 | 1.000 | 1.000 | **0.980 ± 0.044** | 4 ms + **8,233 ms** re-rank |

† **`R1` returning 0.000 is a genuine bug the benchmark caught, and the cause is
not Hebrew morphology.** The code passed the full query to
`websearch_to_tsquery`, which joins unquoted terms with **AND** — `STD-001`'s 13
Hebrew words all had to appear in one chunk. Zero rows returned, every query,
logged verbatim as `R1_sparse top 5: nothing retrieved`. The proof is that `R2`
and `R3` are identical to the last digit: with an empty lexical list, the hybrid
arm falls back to vector results, so **the system was never actually running
hybrid search in production**. Fixed on `feat/ir-benchmark`, since merged to
`main` (commit `76eb1a3`) — *after* the run above, so not reflected in it. `H1`
is therefore **undecided**, and `R1`'s 0.00 leakage figure is vacuous: nothing
can leak when nothing is returned. The isolation evidence rests on `R2`/`R4` and
on the 60 secured end-to-end runs.

### Scope and limits

A **descriptive benchmark, not a statistical study.** 30 queries (21 IR-scorable),
2 relevant chunks each, 120 end-to-end runs. No significance tests were run, so
the 0.944 vs 0.929 gap is not claimed to be significant. The security claim is
different in kind — it is a deterministic count: **0 unauthorized chunks across
60 runs and 90 retrieval observations.** Also documented in §7: the LLM judge was
unavailable for 20 of 28 `Config A` records, two `A` runs timed out at 15,000 ms,
and `Recall@10` is saturated at 1.000 by corpus design.

---

## Quickstart

**Prerequisites:** Node.js 20.18+ (matching CI and both Docker images; the npm
scripts use `node --env-file-if-exists`, which arrived in 20.18), Docker
Compose, and at least one LLM API key (or `LLM_PROVIDER=mock`, the default).

```sh
git clone https://github.com/gavrielsh/scholaragent.git
cd scholaragent
npm install
```

**1 — Configure.** Copy `.env.example` to `.env.local`. The filename matters:
the app and every script call `dotenv.config({ path: ".env.local" })`
explicitly, so a plain `.env` is never read.

```env
DATABASE_URL=postgresql://user:password@localhost:5432/scholaragent
REDIS_URL=redis://127.0.0.1:6379
PG_SSLMODE=disable

LLM_PROVIDER=gemini          # gemini | claude | openai | mock
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
CLAUDE_MODEL=claude-sonnet-4-6

WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
```

The credentials above match the `docker-compose.yml` defaults
(`POSTGRES_USER=user`, `POSTGRES_PASSWORD=password`, `POSTGRES_DB=scholaragent`).

**2 — Start infrastructure.** The default profile brings up Postgres
(`pgvector/pgvector:pg16`) and Redis only; the app and worker containers sit
behind the `full` profile.

```sh
docker compose up -d                  # postgres + redis
docker compose --profile full up -d   # …plus containerized app + worker
```

**3 — Migrate.** This is the step that creates `scholaragent_app` and makes RLS
real. Its self-check fails the migration if enforcement would not hold.

```sh
npm run migrate
```

**4 — Verify.** No database, Redis or network needed:

```sh
npm test            # 271 tests, 21 suites
npx tsc --noEmit
npm run lint
```

**5 — Run.** Two processes — the worker is not optional; the webhook only
enqueues.

```sh
npm run dev               # Next.js app on :3000
npm run worker:whatsapp   # in a second terminal
```

### Reproducing the thesis results

```sh
npm run ingest -- --base local_data/eval_corpus   # 15-document L0/L1/L2 corpus
npm run eval:seed                                 # plant canaries; exits non-zero if controls fail
npm run benchmark                                 # Experiment 1 → scripts/output/benchmark_summary.md
npm run evaluate                                  # Experiment 2 → scripts/output/evaluation_results_*.csv
npm run qrels:pool                                # pool candidates for relevance judging
npm run grade:qrels                               # grade the pooled judgments
```

Run `eval:seed` before `evaluate`. Its positive control proves each canary is
retrievable with RLS bypassed, and its negative control proves it is *not*
retrievable from a lower tier. Without that, a 0% leakage result would be a test
that cannot fail.

### Operations

```sh
npm run reconcile                     # rebuild chunks for documents that lost them
npx tsx scripts/reconcile_documents.ts --dry-run          # report only
npx tsx scripts/reconcile_documents.ts --document-id=<uuid> --verbose
```

`reconcile` finds registered documents with no chunks, recovers their source text
(inline metadata → file under `local_data/documents` → optionally the WhatsApp
media handle), and rebuilds them with the full parent/child chunking and contextual
headers. It exits non-zero if any document failed.

Presenting this live? See **[`docs/demo_runbook.md`](docs/demo_runbook.md)**.

---

## Repository Map

| Path | What lives there |
|---|---|
| `app/api/` | Webhook, upload and deletion endpoints. The webhook verifies, claims, enqueues, ACKs — nothing more |
| `lib/core/` | `db.ts` (RLS transactions, hybrid retrieval, RRF), queue, redis, telemetry, IR metrics |
| `lib/security/` | `auth.ts` (four-tier RBAC), `crypto.ts` (HMAC), `guardrails.ts` (PII, distress handoff) |
| `lib/domain/` | `chat/` (agent, RAG, LLM adapters, re-rank), `ingestion/`, `whatsapp/`, `admin/` |
| `migrations/` | `001` baseline schema, `scholaragent_app` role, grants and RLS · `002` knowledge gaps · `004` parent/child chunks · `005` user memories |
| `scripts/` | Ingestion, Drive sync, reconcile, benchmark, evaluation, canary seeding, qrels pooling and grading |
| `local_data/eval_corpus/` | The 15-document synthetic Hebrew corpus (L0/L1/L2) |
| `docs/` | Research proposals, AI-contribution plan, empirical results (HE), demo runbook |

Dependencies flow strictly inward: `domain` → `security` → `core`. See
[`CLAUDE.md`](CLAUDE.md) for the full engineering contract.

---

## License

MIT. See `LICENSE`.

## Contact

**Gavriel Shalem** — M.Sc. Candidate, Azrieli College of Engineering
[github.com/gavrielsh/scholaragent](https://github.com/gavrielsh/scholaragent)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

[license-shield]: https://img.shields.io/github/license/gavrielsh/scholaragent.svg?style=for-the-badge
[license-url]: https://github.com/gavrielsh/scholaragent/blob/main/LICENSE
[linkedin-shield]: https://img.shields.io/badge/-LinkedIn-black.svg?style=for-the-badge&logo=linkedin&colorB=555
[linkedin-url]: https://linkedin.com/in/gavriel-shalem
