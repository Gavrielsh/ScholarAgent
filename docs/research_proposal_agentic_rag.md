# Research Proposal: Examining Agentic-RAG Architecture for Multi-Layered Secure Knowledge Systems

**Degree:** M.Sc. in Software Engineering, AI Specialization  
**Institution:** Azrieli College of Engineering, Jerusalem  
**Author:** Gabriel Shalom  
**Advisor:** Dr. Asaf Shfeiner  
**Date:** April 2026 (Updated)

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
- How do leading frontier LLM providers (Anthropic Claude 3.5 Sonnet, Google Gemini 1.5/2.0, OpenAI GPT-4o) compare in faithfulness, latency, and instruction adherence under multi-tenant RBAC/RLS constraints?
- Can cross-tier information leakage across hierarchical authorization layers be systematically prevented and quantified via a novel **Data Leakage Score (DLS)**?

---

## 2. Research Hypotheses

| ID | Hypothesis Statement |
|---|---|
| **H1** | **Hybrid Retrieval with Intent Routing** achieves $\ge 15\%$ higher Context Precision and Context Recall than Baseline naive vector search through query classification and Reciprocal Rank Fusion (RRF). |
| **H2** | **Frontier Model Adherence:** Anthropic Claude 3.5 Sonnet and Gemini 1.5 Pro demonstrate statistically superior Faithfulness ($> 90\%$) compared to lightweight models, while maintaining sub-3-second end-to-end response latency. |
| **H3** | **Zero Data Leakage:** Implementing dual-layer security (Application RBAC + Transactional Database RLS) guarantees a Data Leakage Score (DLS) of **0%** in both baseline and agentic configurations, whereas non-RLS baseline configurations yield $	ext{DLS} > 0\%$. |
| **H4** | **Safety Interception:** Pre-retrieval deterministic regex and heuristic signal processing (`SafetySignals`) detects 100% of emergency/distress intents with zero LLM-latency overhead. |

---

## 3. Technical Stack & Implementation Architecture

The system is implemented as a production-grade, event-driven enterprise application:

| Layer / Component | Implemented Technology | Codebase Reference |
|---|---|---|
| **Core Runtime & Backend** | Next.js (App Router), TypeScript (ESNext, Node.js 20+) | `app/api/`, `lib/core/` |
| **Database & Vector Store** | PostgreSQL 16 + `pgvector` (Cosine Distance `<=>`, HNSW/IVFFlat indexing) | `lib/core/db/client.ts`, `lib/core/db/pgvector.ts` |
| **Search Mechanism** | **Hybrid Search:** Dense vector embeddings (1536-dim) + Hebrew/English Full-Text Search (`tsvector`, `ts_rank_cd`) via **Reciprocal Rank Fusion (RRF)** | `lib/core/db/pgvector.ts`, `migrations/001_initial_schema.sql` |
| **Security & Authorization** | Dual-layer: Application-level RBAC + Transactional PostgreSQL Row-Level Security (`SET LOCAL app.current_user_role`) | `lib/security/auth/rbac.ts`, `lib/security/auth/rls.ts`, `migrations/001_initial_schema.sql` |
| **Asynchronous Message Queue** | **BullMQ + Redis** (separate queues for WhatsApp ingestion and heavy document parsing) | `lib/core/queue/`, `lib/domain/ingestion/queue/`, `lib/domain/whatsapp/queue/`, `lib/core/redis/client.ts`, `docker/Dockerfile.worker` |
| **Messaging & Gateway Interface** | WhatsApp Cloud API (Meta Graph API) + HMAC-SHA256 signature verification & Redis idempotency deduplication | `lib/domain/whatsapp/`, `lib/security/crypto/verifySignature.ts`, `app/api/whatsapp/webhook/route.ts` |
| **Agentic State & Orchestration** | Deterministic TypeScript State Orchestrator (`BaselineOrchestrator`, `IntentRouter`, `SafetySignals`, Session Managers) | `lib/domain/chat/agent/baseline/`, `lib/domain/chat/agent/state.ts`, `lib/security/guardrails/safetySignals.ts` |
| **Supported LLM Providers** | **Unified Adapter:** Google Gemini (1.5 Pro, 2.0 Flash), Anthropic Claude (3.5 Sonnet, 3 Haiku), OpenAI (GPT-4o, GPT-4o-mini), Mock Provider | `lib/domain/chat/llm/providers/`, `lib/domain/chat/llm/adapter.ts` |
| **ETL & Data Sanitization** | Semantic chunking with heading preservation + automated PII scrubbing (Israeli ID, phone numbers, emails) | `lib/domain/ingestion/processor/chunker.ts`, `lib/security/privacy/piiRedact.ts` |
| **Evaluation & Benchmark** | Automated evaluation harness with Golden Dataset + RAGAS metric suite + Data Leakage Score (DLS) | `scripts/evaluate_runner.ts`, `scripts/data/golden_dataset.ts`, `lib/core/metrics/` |

### 3.1 Module Boundaries (Domain-Driven Design)

The `lib/` tree is organized into three boundaries, intended so that
dependencies flow inward: domain logic may depend on security and core, but not
the reverse.

| Boundary | Responsibility | Contents |
|---|---|---|
| **`lib/core/`** | Technology-facing infrastructure with no business rules | `db/`, `redis/`, `queue/` (connection + job runtime), `http/`, `env/`, `logger.ts`, `observability/`, `metrics/` |
| **`lib/security/`** | Cross-cutting security concerns enforced independently of any single domain | `auth/` (RBAC, RLS, roles, user registry), `crypto/` (HMAC webhook signature verification), `privacy/` (PII redaction), `guardrails/` (inbound safety signals) |
| **`lib/domain/`** | Business domains, each owning its own processing, queues, and workers | `admin/` (audit logs), `chat/` (`session/`, `agent/`, `llm/`), `ingestion/` (`processor/`, `queue/`, `workers/`), `whatsapp/` (`core/`, `queue/`, `workers/`) |

Two consequences of this layout are relevant to the security claims in Sections 4
and 5. First, PII redaction and the inbound safety guardrails are no longer
embedded inside the ingestion and agent packages respectively; they are
independent security modules invoked by those domains, which makes the
sanitization boundary auditable in isolation. Second, HMAC signature
verification sits in `lib/security/crypto/` rather than in the WhatsApp domain,
so the gateway's authenticity check is separable from its message-parsing logic.

`lib/security/` currently satisfies the intended direction in full: it depends
only on `lib/core/` (the database client and the logger) and imports nothing
from `lib/domain/`. `lib/core/` does **not** yet satisfy it. Four modules retain
outward dependencies inherited from the pre-refactor layout, which the new
boundaries make explicit rather than introduce:

| Module | Outward dependency | Nature |
|---|---|---|
| `lib/core/db/pgvector.ts` | `lib/domain/ingestion/processor/` (`chunker`, `chunkMetadata`, `embeddings`), `lib/security/auth/` | The write path embeds and chunks inline, so the vector store owns ingestion logic |
| `lib/core/metrics/ragas.ts` | `lib/domain/chat/llm/adapter` | LLM-as-judge scoring calls the chat domain's provider adapter |
| `lib/core/observability/tracing.ts` | `lib/domain/chat/llm/types` | Trace payloads are typed in terms of chat message types |
| `lib/core/db/client.ts`, `lib/core/metrics/dls.ts` | `lib/security/auth/types` | `PermissionLevel` / `UserContext` are used as RLS and scoring parameters |

Resolving these requires relocating behavior rather than files — extracting the
embed/chunk step out of the persistence layer, and lifting the shared permission
and message types into a dependency-free `core` contract. That work is
deliberately out of scope for the structural refactor described here, which
preserved all logic unchanged.

All intra-project imports use the absolute `@/lib/...` path alias; no relative
cross-module imports exist, so a module's dependencies — and therefore any
boundary violation — are readable directly from its import block.

---

## 4. Multi-Tier Authorization Model (Four-Tier Hierarchy)

Following schema consolidation into a single canonical baseline (`migrations/001_initial_schema.sql`, which folds in the former incremental series), the system implements a strict **Four-Tier Role-Based and Row-Level Access Control Model (L0–L3)**:

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
  1. **Application-Layer RBAC:** Validates extracted user identity, active state, and role mappings (`lib/security/auth/extractUser.ts`, `lib/security/auth/rbac.ts`).
  2. **Database-Layer Transactional RLS:** Every query executes inside a transaction setting local session variables:
     ```sql
     SET LOCAL app.current_user_role = 'STAFF';
     SET LOCAL app.current_user_id = 'user_uuid';
     ```
     PostgreSQL RLS policies directly filter document chunks and chat session history.
  3. **ETL Scrubbing:** Personally Identifiable Information (PII) is scrubbed via regex-based redaction patterns during ingestion before chunks are vectorized.

---

## 5. Agentic Orchestration & Pipeline Architecture

```
[ Incoming WhatsApp Message / API Request ]
                    │
                    ▼
       [ Signature Verification & Idempotency ]
                    │
                    ▼
             [ Extract User & Role ]
                    │
                    ▼
            [ SafetySignals Check ] ──(Emergency Detected)──► [ Immediate Hotline & Crisis Escalation ]
                    │ (Safe)
                    ▼
             [ IntentRouter ]
         ┌──────────┼───────────────┬────────────────┐
         ▼          ▼               ▼                ▼
  [KNOWLEDGE_QUERY] [ADMIN_ANALYTICS] [CHAT_HISTORY] [GREETING / OUT_OF_SCOPE]
         │                 │               │                 │
         ▼                 ▼               ▼                 ▼
   Hybrid Retrieval  Admin Session    RLS History Fetch Direct LLM / Fallback
 (Dense+Sparse+RRF)  Telemetry Logs   Thread Summary
         │
         ▼
[ RLS Document Filter ] ──► [ DLS Verification Check ]
         │
         ▼
[ Multi-Provider LLM Generation (Gemini / Claude / OpenAI) ]
         │
         ▼
[ Audit Logging & Asynchronous WhatsApp Dispatch via BullMQ ]
```

### 5.1 Pipeline Stages
1. **Security & Ingestion Gateway:** Validates webhook signature (`verifySignature.ts`) using constant-time timing-safe comparisons (`timingSafe.ts`) and Redis-backed idempotency tokens (`idempotency.ts`).
2. **Deterministic Safety Filter (`SafetySignals`):** Intercepts critical psychological distress and physical safety triggers prior to any LLM execution, returning immediate certified emergency resources.
3. **Intent Classification (`IntentRouter`):** Directs incoming payloads into specialized execution paths:
   - `KNOWLEDGE_QUERY`: Multi-source knowledge base retrieval.
   - `ADMIN_ANALYTICS`: Schema and audit metrics restricted strictly to `L0: ADMIN`.
   - `CHAT_HISTORY`: Contextual session history retrieval with user RLS isolation.
   - `GREETING` / `OUT_OF_SCOPE`: Zero-retrieval cost-effective conversational paths.
4. **Hybrid Retrieval with Reciprocal Rank Fusion (RRF):** Queries pgvector using cosine distance while simultaneously running full-text search with Hebrew language dictionaries, merging scores via:
   $$RRF\_Score(d) = \sum_{m \in M} \frac{1}{k + r_m(d)}$$
   where $k=60$ and $r_m(d)$ is the rank of document $d$ in retrieval method $m$.
5. **Post-Retrieval Security Guard:** Calculates the retrieval Data Leakage Score and logs query telemetry to the `audit_logs` table.

---

## 6. Evaluation Framework & Novel Metrics

The experimental evaluation is conducted using the automated evaluation harness (`scripts/evaluate_runner.ts`) executed over the standardized `golden_dataset.ts`:

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
| **Phase 1: Foundation (March 2026)** | Database schema, pgvector setup, migrations (001–009), multi-tier RLS enforcement, ETL & PII scrubbing pipeline. | **Completed** (Production schema & migrations verified) |
| **Phase 2: Core Architecture (April 2026)** | BullMQ + Redis async workers, WhatsApp API integration, Baseline Hybrid Search, IntentRouter & SafetySignals modules. | **Completed** (Full pipeline implemented in codebase) |
| **Phase 3: Multi-Provider Integration (May 2026)** | Implementation of unified LLM adapter (Gemini 1.5/2.0, Claude 3.5 Sonnet, GPT-4o, MockProvider), golden evaluation dataset construction. | **In Progress** (Adapters ready, benchmark dataset compiled) |
| **Phase 4: Benchmarking & Reporting (June 2026)** | Automated benchmark execution (`evaluate_runner.ts`), statistical analysis of RAGAS metrics & DLS across models, M.Sc. thesis compilation. | **Scheduled** |

---

## 8. Ethical & Privacy Considerations

1. **Israeli Privacy Law Compliance:** Adheres to the Israeli Privacy Protection Law (5741-1981) and Protection of Privacy Regulations (Data Security, 5777-2017).
2. **Automated PII Redaction:** Pre-ingestion scrubbing eliminates Israeli National Identification Numbers (*Teudat Zehut*), telephone numbers, email addresses, and payment data.
3. **Emergency Crisis Protocol:** Automated deterministic detection of self-harm, severe trauma, or domestic abuse signals triggers immediate routing to certified crisis resources and alerts designated human supervisors.
4. **Data Minimization:** No personal chat transcripts or contact details are used for LLM fine-tuning or external model training.
