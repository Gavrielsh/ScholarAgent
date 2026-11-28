# Research Proposal: Examining Agentic-RAG Architecture

**Degree:** M.Sc in Software Engineering, AI Specialization  
**Institution:** Azrieli College of Engineering  
**Author:** Gabriel Shalom  
**Advisor:** Dr. Asaf Shfeiner  
**Date:** April 2026 (short form; status updated to the current `main`)

> **Status note.** This is the short-form proposal. The full draft is
> `docs/research_proposal_agentic_rag.md`, the revised research design is
> `docs/research_proposal_revised.md`, and the measured results are in
> `docs/experimental_results.md`. The implementation is a **deterministic**
> pipeline — lexical intent routing into bounded handlers, one generation call per
> turn — and not an autonomous, tool-calling agent.

---

## 1. Research Focus

Examining **secure knowledge management with tiered RAG in multi-layered systems**,
implemented for the social-educational organization "Person to Person is Heart". The
deployment uses a four-tier permission model (L0–L3) for the organization's
administrators, managers, staff and volunteers.

**Primary Research Question:**  
How much authorization containment in a role-restricted RAG system comes from
database-enforced retrieval, and how much from the language model's own behaviour —
measured in terms of retrieval accuracy, security constraint compliance, and data
leakage prevention?

**Sub-questions:**
- How does language model selection (Claude Sonnet 4.6 vs. Gemini 3.5 Flash) impact
  leakage and answer quality under RLS?
- Does hybrid retrieval (dense + lexical, fused by RRF) improve retrieval over
  dense-only search in Hebrew?
- How can information leakage across authorization layers be quantified?

---

## 2. Hypotheses

The original three hypotheses below were revised after review (see
`docs/research_proposal_revised.md` §2); they are kept here for comparison.

| ID | Hypothesis |
|----|------------|
| H1 | Hybrid retrieval with intent routing achieves ≥15% higher Context Precision than naive vector search |
| H2 | One of the two evaluated models shows higher Faithfulness but greater latency than the other |
| H3 | Data Leakage Score = 0% under database-enforced RLS, but > 0% when authorization is left to the prompt |

---

## 3. Technical Stack

| Component | Technology |
|-----------|-----------|
| Backend | TypeScript / Next.js 14 |
| Database | PostgreSQL 16 + pgvector (768-dim embeddings, `gemini-embedding-001`) |
| Security | Four-tier RBAC lookup (application) + RLS (database): `FORCE ROW LEVEL SECURITY`, tier passed per transaction, queries run as the least-privilege `scholaragent_app` role |
| Orchestration | Deterministic TypeScript pipeline: lexical intent routing and bounded handlers (no LangGraph, no autonomous tool loop) |
| Language Models | `claude-sonnet-4-6` (fast tier `claude-haiku-4-5`), `gemini-3.5-flash`, `gpt-4o-mini`, and a deterministic mock |
| Async execution | BullMQ + Redis |
| Evaluation | RAGAS-style metrics + novel Data Leakage Score (DLS); per-query `executionCostUsd` telemetry |

---

## 4. Authorization Model (Four-Tier)

| Level | Role | Access |
|-------|------|--------|
| L0 | Admin | Full access to all knowledge |
| L1 | Manager | Organizational management data |
| L2 | Staff | Staff-level operational data |
| L3 | Volunteer | Volunteer-facing content |

A lower number is more privileged: a row is visible when the caller's level is
less than or equal to the row's `classification_level`.

Security is enforced at two layers:
- **Application layer:** the sender is identified and their role looked up before any
  query; corpus writes are restricted to L0/L1.
- **Database layer:** PostgreSQL RLS policies filter rows by
  `classification_level >= user_permission_level`. The tier is set with
  `set_config('app.user_permission_level', …, true)` and the connection then switches
  to `scholaragent_app` (`SET LOCAL ROLE`), so the policies are always evaluated.

---

## 5. Evaluation Metrics

| Metric | Target | Source |
|--------|--------|--------|
| Context Precision | > 80% | RAGAS |
| Faithfulness | > 90% | RAGAS |
| Answer Relevancy | > 85% | RAGAS |
| Data Leakage Score (DLS) | 0% | Novel (this research) |
| Latency | < 3 seconds | Custom benchmark (the recorded end-to-end means were 9–18 s; see `docs/experimental_results.md`) |

### 5.1 Data Leakage Score (DLS) — Novel Metric

An original security metric developed to address gaps in standard evaluation tools.

```
DLS = (unauthorized_chunks / total_retrieved_chunks) × 100
```

- **0%** = perfect RLS enforcement — no unauthorized content in the context window
- **> 0%** = security failure — at least one unauthorized chunk reached the model

A chunk is **unauthorized** when `chunk.classificationLevel < user.permissionLevel`  
(the chunk requires higher privilege than the user possesses).

---

## 6. Timeline

| Period | Milestone | Status |
|--------|-----------|--------|
| March 2026 | Database schema definition & ETL pipeline | Completed |
| April 2026 | Baseline RAG implementation | Completed |
| May 2026 | Orchestration, multi-provider LLM adapter, evaluation harness | Completed |
| June 2026 onward | Evaluation, benchmarking, academic reporting | Experiments run 2026-11-18 (descriptive); statistical treatment pending |

---

## 7. Ethical Considerations

- All personal data anonymized prior to ingestion
- Knowledge base access restricted to research purposes
- Organizational approval obtained from "Person to Person is Heart"
- Compliant with Israeli privacy protection requirements
