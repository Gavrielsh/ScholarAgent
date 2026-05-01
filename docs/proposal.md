# Research Proposal: Examining Agentic-RAG Architecture

**Degree:** M.Sc in Software Engineering, AI Specialization  
**Institution:** Azrieli College of Engineering  
**Author:** Gabriel Shalom  
**Advisor:** Dr. Asaf Shfeiner  
**Date:** April 2026

---

## 1. Research Focus

Examining **Agentic-RAG for secure knowledge management in multi-layered systems**, implemented for the social-educational organization "Person to Person is Heart" — which serves nine distinct user groups with varying permission levels.

**Primary Research Question:**  
What added value does Agentic-RAG provide compared to Baseline RAG in terms of retrieval accuracy, security constraint compliance, and data leakage prevention?

**Sub-questions:**
- How does language model selection (Gemini 1.5 Pro vs. Llama 3) impact RLS compliance?
- Do deterministic state graphs (LangGraph) improve answer faithfulness?
- How can information leakage across authorization layers be quantified?

---

## 2. Hypotheses

| ID | Hypothesis |
|----|------------|
| H1 | Agentic-RAG achieves ≥15% higher Context Precision than Baseline RAG via dynamic tool selection |
| H2 | Gemini 1.5 Pro shows higher Faithfulness but greater Latency than Llama 3 |
| H3 | Data Leakage Score = 0% in Agentic configurations, but > 0% in Baseline |

---

## 3. Technical Stack

| Component | Technology |
|-----------|-----------|
| Backend | TypeScript / Next.js |
| Database | PostgreSQL 16 + pgvector |
| Security | RBAC (application) + RLS (database) |
| Agent Framework | LangGraph (deterministic state machine) |
| Language Models | Gemini 1.5 Pro, Llama 3 |
| Evaluation | RAGAS + novel Data Leakage Score (DLS) |

---

## 4. Authorization Model (Five-Tier)

| Level | Role | Access |
|-------|------|--------|
| L0 | Admin | Full access to all knowledge |
| L1 | Manager | Organizational management data |
| L2 | Staff | Staff-level operational data |
| L3 | Volunteer | Volunteer-facing content |
| L4 | Guest | Public content only |

Security is enforced at two layers:
- **Application layer:** RBAC middleware validates user role before query
- **Database layer:** PostgreSQL RLS policies filter rows by `classification_level >= user_permission_level`

---

## 5. Evaluation Metrics

| Metric | Target | Source |
|--------|--------|--------|
| Context Precision | > 80% | RAGAS |
| Faithfulness | > 90% | RAGAS |
| Answer Relevancy | > 85% | RAGAS |
| Data Leakage Score (DLS) | 0% | Novel (this research) |
| Latency | < 3 seconds | Custom benchmark |

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

| Period | Milestone |
|--------|-----------|
| March 2026 | Database schema definition & ETL pipeline |
| April 2026 | Baseline RAG implementation |
| May 2026 | Agentic-RAG development (LangGraph nodes) |
| June 2026 | Evaluation, benchmarking, academic reporting |

---

## 7. Ethical Considerations

- All personal data anonymized prior to ingestion
- Knowledge base access restricted to research purposes
- Organizational approval obtained from "Person to Person is Heart"
- Compliant with Israeli privacy protection requirements
