# Research Proposal: Examining Agentic-RAG Architecture for Multi-Layered Secure Knowledge Systems

**Degree:** M.Sc. in Software Engineering, AI Specialization  
**Institution:** Azrieli College of Engineering, Jerusalem  
**Author:** Gabriel Shalom  
**Advisor:** Dr. Asaf Shfeiner  
**Date:** April 2026 (Updated)

> **Status note (current `main`).** This is the original proposal, kept for comparison.
> Its hypotheses were superseded by `docs/research_proposal_revised.md`, and the
> experiments actually run are reported in `docs/experimental_results.md`. The technical
> sections below describe the implementation as it exists today: a **deterministic**,
> state-orchestrated pipeline — lexical intent routing into bounded handlers and one
> generation call per turn — not an autonomous tool-calling agent.

---

## 1. Research Focus & Problem Statement

Organizations operating in social, educational, and non-profit sectors face strict regulatory and ethical constraints regarding data privacy, role-based confidentiality, and emergency response. This research investigates an **Agentic-RAG architecture for secure knowledge management in multi-layered organizational systems**, empirically developed and evaluated for the social-educational organization **"Person to Person is Heart"**.

While Baseline Retrieval-Augmented Generation (RAG) systems integrate semantic vector retrieval with Large Language Models (LLMs), they frequently suffer from:
1. **Context pollution and cross-tier unauthorized data leakage.**
2. **Sub-optimal retrieval precision** when handling multi-faceted queries requiring sparse-dense correlation.
3. **Lack of deterministic safeguards** for mission-critical intents (e.g., life-threatening emergency signals requiring zero-latency human escalation).

### Primary Research Question
What added value does a deterministic, state-orchestrated **Agentic-RAG** architecture provide over **Baseline RAG** in terms of retrieval accuracy, multi-tier security constraint compliance, and data leakage prevention in enterprise communication workflows?

### Sub-Questions
- How does **Hybrid Search** (Dense Vector Cosine Distance + Sparse Full-Text Search via Reciprocal Rank Fusion) combined with transactional PostgreSQL Row-Level Security (RLS) impact retrieval precision and security boundary enforcement?
- How do leading frontier LLM providers (Anthropic Claude Sonnet 4.6, Google Gemini 3.5 Flash, OpenAI GPT-4o-mini) compare in faithfulness, latency, and instruction adherence under multi-tenant RBAC/RLS constraints?
- Can cross-tier information leakage across hierarchical authorization layers be systematically prevented and quantified via a novel **Data Leakage Score (DLS)**?

---

## 2. Research Hypotheses

| ID | Hypothesis Statement |
|---|---|
| **H1** | **Hybrid Retrieval with Intent Routing** achieves $\ge 15\%$ higher Context Precision and Context Recall than Baseline naive vector search through query classification and Reciprocal Rank Fusion (RRF). |
| **H2** | **Frontier Model Adherence:** Anthropic `claude-sonnet-4-6` and Google `gemini-3.5-flash` demonstrate statistically superior Faithfulness ($> 90\%$) compared to lightweight models, while maintaining sub-3-second end-to-end response latency. |
| **H3** | **Zero Data Leakage:** Implementing dual-layer security (Application RBAC + Transactional Database RLS) guarantees a Data Leakage Score (DLS) of **0%** in both baseline and agentic configurations, whereas non-RLS baseline configurations yield $\text{DLS} > 0\%$. |
| **H4** | **Safety Interception:** Pre-retrieval deterministic regex and heuristic signal processing (`evaluateInboundSafety`) detects 100% of emergency/distress intents with zero LLM-latency overhead. |

---

## 3. Technical Stack & Implementation Architecture

The system is implemented as a production-grade, event-driven enterprise application:

| Layer / Component | Implemented Technology | Codebase Reference |
|---|---|---|
| **Core Runtime & Backend** | Next.js 14 (App Router), TypeScript, Node.js 20.18+ | `app/api/`, `lib/core/` |
| **Database & Vector Store** | PostgreSQL 16 + `pgvector` (cosine distance `<=>`, HNSW `m=16`, `ef_construction=64`, 768 dimensions) | `lib/core/db.ts`, `migrations/001_initial_schema.sql` |
| **Embeddings** | `gemini-embedding-001` at 768 dimensions, batched with paced slices and retry | `lib/domain/ingestion/embeddings.ts` |
| **Search Mechanism** | **Hybrid Search:** dense vector search + lexical search (`ts_rank_cd` over `to_tsvector('simple')`, OR-joined terms) fused by **Reciprocal Rank Fusion** (k = 60); small-to-big parent/child chunks | `lib/core/db.ts` (`executeRetrieval`, `reciprocalRankFusion`, `resolveParentChunks`), `migrations/004_parent_child_chunks.sql` |
| **Security & Authorization** | Four-tier RBAC lookup plus database-enforced RLS: per transaction `set_config('app.user_permission_level', …, true)` followed by `SET LOCAL ROLE scholaragent_app` (`NOLOGIN NOSUPERUSER NOBYPASSRLS`); `FORCE ROW LEVEL SECURITY` on `knowledge_base`, `ingested_documents`, `chat_history` | `lib/security/auth.ts`, `lib/core/db.ts`, `migrations/001_initial_schema.sql` |
| **Asynchronous Message Queue** | **BullMQ + Redis**: one queue for WhatsApp chat, one for document ingestion | `lib/core/queue.ts`, `lib/core/redis.ts`, `lib/domain/whatsapp/worker.ts`, `lib/domain/ingestion/worker.ts`, `docker/Dockerfile.worker` |
| **Messaging & Gateway Interface** | WhatsApp Cloud API; HMAC-SHA256 verified against the raw body with a timing-safe compare; Redis `SET NX` idempotency claim | `app/api/whatsapp/webhook/route.ts`, `lib/security/crypto.ts`, `lib/domain/whatsapp/` |
| **Orchestration** | Deterministic TypeScript orchestration: `processBaselineQuery` routes lexically into bounded handlers (knowledge RAG, chat history, L0/L1 admin flows) with session modes. The model makes no control decisions and there is no tool loop | `lib/domain/chat/agent.ts`, `lib/domain/chat/state.ts`, `lib/domain/chat/session/` |
| **Safety Guardrails** | Deterministic pre-LLM distress handoff, privacy screens and PII redaction (`redactPii`) | `lib/security/guardrails.ts` |
| **Supported LLM Providers** | **Unified adapter** over raw HTTP (no vendor SDK): Anthropic Claude (`claude-sonnet-4-6`; fast tier `claude-haiku-4-5`), Google Gemini (`gemini-3.5-flash`), OpenAI (`gpt-4o-mini`), and a deterministic Mock. Two retries (500 ms, 1,500 ms) on 429, 5xx and timeout | `lib/domain/chat/llm.ts` |
| **ETL & Data Sanitization** | PDF / DOCX / TXT / MD / CSV extraction (no OCR: an image-only PDF is rejected), PII scrubbing (Israeli ID, phone numbers, emails), Hebrew-aware sentence chunking with heading detection, parent/child chunks (1,400 / 400, overlap 60) and a contextual header per chunk | `lib/domain/ingestion/pipeline.ts`, `lib/security/guardrails.ts` |
| **Reconciliation** | Rebuilds chunks for registered documents that lost them, through the same parent/child + header helpers as live ingestion | `scripts/reconcile_documents.ts`, `backfillDocumentChunks` in `lib/core/db.ts` |
| **Evaluation & Benchmark** | Evaluation harness over a 30-query golden dataset, RAGAS-style metrics, retrieval- and generation-stage Data Leakage Score, IR benchmark of four retrieval arms | `scripts/evaluate_runner.ts`, `scripts/data/golden_dataset.json`, `scripts/benchmark_retrieval.ts`, `lib/core/telemetry.ts`, `lib/core/irMetrics.ts` |
| **Telemetry & Cost** | Optional Langfuse tracing; provider-reported token usage priced per model into `executionCostUsd` (an estimate; absent for mock or unpriced models) | `lib/core/telemetry.ts`, `lib/domain/chat/llm.ts` |

### 3.1 Module Boundaries (Domain-Driven Design)

The `lib/` tree is organized into three boundaries, so that dependencies flow
inward: domain logic may depend on security and core, but not the reverse.

| Boundary | Responsibility | Contents |
|---|---|---|
| **`lib/core/`** | Technology-facing infrastructure with no business rules | `db.ts`, `db/accessLevel.ts`, `queue.ts`, `redis.ts`, `telemetry.ts`, `irMetrics.ts`, `env.ts`, `logger.ts`, `http/fetchWithTimeout.ts` |
| **`lib/security/`** | Cross-cutting security concerns enforced independently of any single domain | `auth.ts` (four-tier RBAC, user registry, phone normalization), `crypto.ts` (HMAC webhook verification), `guardrails.ts` (PII redaction, distress handoff, privacy screens), `extractUser.ts` (JWT identity) |
| **`lib/domain/`** | Business domains | `admin/` (audit logs), `chat/` (agent, RAG, LLM adapters, `session/`), `ingestion/` (pipeline, embeddings, retrieval, worker), `whatsapp/` (webhook handling, worker, client) |

Two consequences of this layout are relevant to the security claims in Sections 4
and 5. First, PII redaction and the inbound safety guardrails are independent
security modules invoked by the domains, which makes the sanitization boundary
auditable in isolation. Second, HMAC signature verification sits in
`lib/security/crypto.ts` rather than in the WhatsApp domain, so the gateway's
authenticity check is separable from its message-parsing logic.

Both boundaries satisfy the intended direction in full. `lib/security/` imports
nothing from `lib/domain/`, and `lib/core/` imports from neither `lib/domain/` nor
`lib/security/`. The shared permission type is the dependency-free `AccessLevel`
contract in `lib/core/db/accessLevel.ts`, which both `lib/core/db.ts` and
`lib/core/telemetry.ts` consume structurally without knowing the role model around
it. The consolidation is enforced by review and by the module layout described in
`CLAUDE.md`.

All intra-project imports use the absolute `@/lib/...` path alias; no relative
cross-module imports exist, so a module's dependencies — and therefore any
boundary violation — are readable directly from its import block.

---

## 4. Multi-Tier Authorization Model (Four-Tier Hierarchy)

The schema lives in a single canonical baseline (`migrations/001_initial_schema.sql`),
with `002` (knowledge gaps), `004` (parent/child chunks) and `005` (user memories)
applied on top. The system implements a strict **Four-Tier Role-Based and Row-Level
Access Control Model (L0–L3)**:

```
[L0: ADMIN] (Permission Level 0) ──► Full system visibility, audit logs, system telemetry
    │
[L1: MANAGER] (Permission Level 1) ──► Organizational management, operational analytics, branch data
    │
[L2: STAFF] (Permission Level 2) ──► Case-specific operational files, internal schedules, staff guides
    │
[L3: VOLUNTEER] (Permission Level 3) ──► Volunteer-facing content, general protocols, activity guides
```

### 4.1 Hierarchical Constraint Logic
In this numeric representation, a lower integer denotes a higher privilege level ($0 \le \text{Level} \le 3$).

- **Access Invariant:** A user with permission level $P_{\text{user}}$ is permitted to retrieve chunk $C$ if and only if:
  $$\text{ClassificationLevel}(C) \ge P_{\text{user}}$$
- **Enforcement Layers:**
  1. **Application-Layer RBAC:** Validates the sender's identity and role (`lookupUserByPhone` / `lookupUserById` in `lib/security/auth.ts`; JWT identity in `lib/security/extractUser.ts`). Corpus writes are restricted to L0/L1, and a tier can manage only tiers below it.
  2. **Database-Layer Transactional RLS:** Every user-facing query executes inside a transaction that sets the tier and then drops privileges:
     ```sql
     BEGIN;
     SELECT set_config('app.user_permission_level', '<tier>', true);   -- GUC first
     SET LOCAL ROLE scholaragent_app;   -- NOLOGIN, NOSUPERUSER, NOBYPASSRLS
     -- ... query ...
     COMMIT;   -- SET LOCAL reverts: no tier leaks onto the next pooled use
     ```
     Own-history reads use `app.sender_id` the same way. `FORCE ROW LEVEL SECURITY` is enabled on `knowledge_base`, `ingested_documents` and `chat_history`, and every policy reads the setting as `nullif(current_setting('app.user_permission_level', true), '')::integer`, so a pooled connection that returns `''` denies rows instead of raising. Write policies additionally require `classification_level >= tier`. If the role is missing, `enterAppRole` throws rather than running as a superuser, and migration 001 contains a self-check that aborts if the role is privileged or `FORCE` is off.
  3. **ETL Scrubbing:** Personally Identifiable Information (PII) is scrubbed via regex-based redaction patterns during ingestion before chunks are vectorized.

---

## 5. Deterministic Orchestration & Pipeline Architecture

The orchestration is a deterministic state machine, not an autonomous agent: routing is
lexical (regular expressions and heuristics), each turn is either a bounded handler or a
single generation call, and no model output ever selects a tool or triggers a second
retrieval.

```
[ Incoming WhatsApp Message / API Request ]
                    │
                    ▼
 [ HMAC verification (raw body) → Redis idempotency claim → enqueue → ACK ]   (webhook route)
                    │
                    ▼
      [ BullMQ worker: sanitize (truncate + redactPii) → user lookup ]
                    │
                    ▼
         [ evaluateInboundSafety ] ──(Distress / blocked privacy request)──► [ Handoff or refusal, before any LLM call ]
                    │ (Proceed)
                    ▼
        [ processBaselineQuery: lexical intent routing ]
         ┌──────────┼────────────────┬──────────────────┐
         ▼          ▼                ▼                  ▼
  [RAG_INQUIRY] [L0 / L1 admin    [CHAT_HISTORY]   [User-management
         │        handlers]            │             flows (L0/L1)]
         ▼                             ▼
  Hybrid Retrieval              RLS history fetch
 (Dense + Lexical + RRF,        + summary
  parent resolution)
         │
         ▼
[ RLS-scoped retrieval ] ──► [ computeDls defence-in-depth check ]
         │
         ▼
[ One LLM generation call (Claude / Gemini / OpenAI / Mock) ]
         │
         ▼
[ WhatsApp send → persist assistant turn → audit log, knowledge-gap record, cost telemetry ]
```

### 5.1 Pipeline Stages
1. **Security & Ingestion Gateway:** Validates the webhook signature (`verifyMetaSignature` in `lib/security/crypto.ts`) with timing-safe comparison and claims the message id with a Redis `SET NX` (`lib/core/redis.ts`). Nothing that touches Postgres or an LLM runs in the route.
2. **Deterministic Safety Filter:** `evaluateInboundSafety` (`lib/security/guardrails.ts`) intercepts distress and privacy-sensitive requests before any LLM execution. Distress is checked for every tier and returns a human-handoff response; the privacy screens are skipped for L0/L1.
3. **Intent Routing (`processBaselineQuery`):** Lexical routing into specialized paths:
   - `RAG_INQUIRY`: knowledge-base retrieval followed by a single generation call. Greetings and out-of-domain requests are handled by the system-prompt rules of that same call.
   - `CHAT_HISTORY`: history Q&A for elevated roles, with RLS isolation.
   - Admin handlers: L0 analytics and user management, L1 daily staff summary, each bounded and role-guarded.
4. **Hybrid Retrieval with Reciprocal Rank Fusion (RRF):** Queries pgvector using cosine distance while running the lexical leg, merging scores via:
   $$RRF\_Score(d) = \sum_{m \in M} \frac{1}{k + r_m(d)}$$
   where $k=60$ and $r_m(d)$ is the rank of document $d$ in retrieval method $m$. A matched child chunk is widened to its parent inside the same RLS transaction.
5. **Post-Retrieval Security Guard:** Calculates the retrieval Data Leakage Score on the returned chunks, strips any unauthorized chunk before it reaches the model, and logs query telemetry to the `audit_logs` table.
6. **Cost Telemetry:** The adapter reports provider token usage and `lib/core/telemetry.ts` prices it into `executionCostUsd`, recorded on the Langfuse trace and the `baseline_rag.llm_cost` log line.

---

## 6. Evaluation Framework & Novel Metrics

The experimental evaluation is conducted using the automated evaluation harness (`scripts/evaluate_runner.ts`) executed over the standardized golden dataset (`scripts/data/golden_dataset.json`, 30 queries):

| Metric | Target | Evaluation Tool / Method | Mathematical Definition / Meaning |
|---|---|---|---|
| **Context Precision** | > 85% | RAGAS | Measures the proportion of relevant chunks retrieved in top positions. |
| **Faithfulness** | > 90% | RAGAS | Assesses whether the generated response is strictly grounded in retrieved chunks (hallucination minimization). |
| **Answer Relevancy** | > 85% | RAGAS | Measures semantic alignment between the prompt and generated response. |
| **Context Recall** | > 85% | RAGAS | Assesses whether all ground-truth facts were successfully retrieved. |
| **Data Leakage Score (DLS)** | **0.0%** | Novel Security Metric | Percentage of retrieved chunks violating the user's role authorization boundaries. |
| **End-to-End Latency** | < 3,000 ms | Profiling Telemetry | Time breakdown: Routing + Hybrid Retrieval + LLM Generation + Post-checks. |

### 6.1 Data Leakage Score (DLS) — Novel Metric Formulation
Standard RAG evaluation frameworks (such as RAGAS or TruLens) lack native formalisms for role-based retrieval containment. DLS provides a quantitative index of authorization violations:

$$\text{DLS} = \left( \frac{\sum_{i=1}^{N} \mathbb{I}(\text{ClassificationLevel}(C_i) < P_{\text{user}})}{N} \right) \times 100$$

Where:
- $N$ is the total number of retrieved context chunks supplied to the context window.
- $C_i$ represents retrieved chunk $i$.
- $P_{\text{user}}$ is the user's numerical permission level ($0 \le P_{\text{user}} \le 3$).
- $\mathbb{I}(\cdot)$ is the indicator function equal to $1$ if the condition is met (unauthorized chunk present) and $0$ otherwise.

**Interpretation:**
- $\text{DLS} = 0.0\%$: Perfect security compliance; zero unauthorized chunks exposed.
- $\text{DLS} > 0.0\%$: Critical authorization failure; sensitive data leaked into the model context window.

---

## 7. Research Timeline & Milestones

| Period | Target Milestone | Status / Deliverables |
|---|---|---|
| **Phase 1: Foundation (March 2026)** | Database schema, pgvector setup, migrations (`001` baseline, `002` knowledge gaps, `004` parent/child chunks, `005` user memories), multi-tier RLS enforcement, ETL & PII scrubbing pipeline. | **Completed** |
| **Phase 2: Core Architecture (April 2026)** | BullMQ + Redis async workers, WhatsApp API integration, hybrid search, lexical intent routing and safety guardrails. | **Completed** |
| **Phase 3: Multi-Provider Integration (May 2026)** | Unified LLM adapter (Claude, Gemini, OpenAI, Mock), golden evaluation dataset, per-query cost telemetry. | **Completed** |
| **Phase 4: Benchmarking & Reporting (June 2026 onward)** | Experiment 1 (retrieval arms R1–R4) and Experiment 2 (4 configurations × 30 queries) executed on 2026-11-18 (`docs/experimental_results.md`). Repetitions, bootstrap confidence intervals, significance tests and judge validation against human labels are **not yet done**. | **Executed, descriptive; statistical treatment pending** |

---

## 8. Ethical & Privacy Considerations

1. **Israeli Privacy Law Compliance:** Adheres to the Israeli Privacy Protection Law (5741-1981) and Protection of Privacy Regulations (Data Security, 5777-2017).
2. **Automated PII Redaction:** Pre-ingestion scrubbing eliminates Israeli National Identification Numbers (*Teudat Zehut*), telephone numbers, email addresses, and payment data.
3. **Emergency Crisis Protocol:** Automated deterministic detection of self-harm, severe trauma, or domestic abuse signals triggers immediate routing to certified crisis resources and alerts designated human supervisors.
4. **Data Minimization:** No personal chat transcripts or contact details are used for LLM fine-tuning or external model training.
