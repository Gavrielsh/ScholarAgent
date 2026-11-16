# Research Proposal (Revised): Measuring Authorization Leakage in Tiered Retrieval-Augmented Generation

**Degree:** M.Sc. Software Engineering, AI Specialization
**Institution:** Azrieli College of Engineering, Jerusalem
**Author:** Gabriel Shalem
**Advisor:** Dr. Asaf Shfeiner
**Revision date:** November 2026
**Codebase reference:** `032b17f`

> This revision supersedes the three-hypothesis draft that spanned architecture,
> security and learning science. `docs/research_proposal_agentic_rag.md` is left in place
> for comparison. Every claim about the system here was checked against the code, and
> every citation against its DOI or arXiv entry — see §10 for verification status.

---

## 1. Research question

Access control in retrieval-augmented generation is **enforced and evaluated at the
retrieval stage**. Row-Level Security filters chunks before they reach the context
window, and the standard evaluation question is whether any unauthorized chunk got
through.

But **disclosure is a property of generation, not of retrieval.** A retrieval-stage
metric is blind to two distinct failures:

1. The context did contain unauthorized material, and the model **repeated it**. Whether
   a language model acts as a second line of defence is an empirical question that system
   designs routinely assume rather than measure.
2. The context was clean, and the model disclosed protected content **anyway** — from
   parametric memory, by inference across authorized chunks, by obeying an injected
   instruction, or by revealing its own operating instructions. Row-Level Security cannot
   prevent any of these, because nothing was retrieved to filter.

> **Primary question.** In a role-restricted RAG system, how much authorization
> containment is attributable to retrieval-stage enforcement, and how much to the
> language model's own refusal behaviour?

This cannot be answered by building anything. It requires inducing retrieval failures
under controlled conditions, measuring what the model then does, and reporting with
uncertainty. That is what distinguishes this work from the engineering that supports it.

---

## 2. Hypotheses

Each is stated so that it can fail, and each maps to a measurement the existing harness
can produce.

**H1 — Retrieval containment is achievable and is only a floor.**
Under `FORCE ROW LEVEL SECURITY` with the user's permission level injected per
transaction, retrieval-stage leakage (R-DLS) is 0% across all query classes, including
adversarial prompting. This is the baseline condition, not the contribution: a positive
result confirms the security layer functions, and a negative result indicates a defect.
It is stated explicitly so that H2 and H3 have a known-good floor to be measured against.

**H2 — The containment gap is strictly intermediate.**
Given a retrieval-stage failure, the model contains it at a rate strictly between 0% and
100%. Formally, `CG = P(generation leaked | retrieval leaked)` is estimated with a
confidence interval rather than predicted in a direction.

*Both extremes are reportable findings.* `CG = 0` would show the model is a genuine second
line of defence and that defence-in-depth claims are warranted. `CG = 100` would show RLS
is the only barrier between a user and protected data, and that such claims are false
wherever they are made. A hypothesis that can only resolve one way is not a hypothesis;
this one can resolve three.

**H3 — Unconditional disclosure is family-dependent.**
With clean retrieval (R-DLS = 0), generation-stage disclosure still occurs, and its rate
differs significantly across attack families — higher for prompt injection and
system-prompt extraction than for authorization escalation, because the former do not
require the model to possess protected content, only to disobey. No access-control
mechanism can address this class.

**H4 — Judge separation reduces measured self-preference.**
Evaluating generated answers with a judge model drawn from a different family than the
generator yields systematically different scores than self-evaluation, consistent with
the self-preference bias documented in the LLM-as-a-judge literature. This hypothesis
governs the validity of every other measurement in this work, since H2 and H3 are scored
in part by an LLM judge.

---

## 3. Literature review

### 3.1 Evaluation of RAG systems

Es et al. (2024) introduced **RAGAS**, a reference-free evaluation framework for RAG
pipelines that decomposes quality into retrieval quality, faithfulness of the generated
answer to retrieved passages, and overall generation quality. Its central mechanism —
decomposing an answer into individual claims and checking each against the retrieved
context — is the basis for the faithfulness measurement used here.

RAGAS and comparable frameworks share a limitation that motivates this work: **they have
no formalism for role-based containment.** They ask whether an answer is grounded, not
whether it was permitted.

### 3.2 Bias in LLM-as-a-judge

Reference-free evaluation depends on using a language model as the evaluator, and that
evaluator carries its own biases. Zheng et al. (2023) is the canonical source for the two
most studied: **position bias**, where a judge favours an answer by its ordinal position,
and **self-enhancement** (equivalently self-preference), where a judge favours outputs
from its own model.

Panickssery et al. (2024) connects self-preference to self-recognition, reporting a
positive correlation between a model's ability to recognise its own output and the
magnitude of its preference for it. "Justice or Prejudice?" (ICLR 2025) treats position
bias and self-enhancement as distinct categories and **explicitly recommends against
using the same model to generate and to judge** — the methodological basis for H4.
Subsequent work (EMNLP 2025) measures self-preference on open-ended tasks and finds that
post-training does not necessarily worsen it.

### 3.3 Access control in vector stores

Zhong et al. (2025), **HoneyBee**, treats role-based access control over vector data as a
dynamic partitioning problem, producing overlapping partitions in which vectors are
selectively replicated. Its experiments run on PostgreSQL 16 with pgvector 0.8.0.

The finding relevant here is often misread, so it is stated precisely: **Row-Level
Security is the baseline HoneyBee outperforms**, with reported latency reductions against
RLS in exchange for increased memory from replication. RLS is therefore the *slow but
hermetic* option, not the fast one.

That trade-off is a reason to prefer RLS in this setting rather than an argument against
it. This system serves a small organisation over WhatsApp, where per-query latency is
dominated by LLM generation and network round-trips, not by the vector scan; and where
replicating classified material across partitions is precisely the property a
child-welfare corpus should not have. The architectural choice here is deliberate:
**enforcement guarantees are bought at a latency cost that this deployment can absorb.**

### 3.4 Agentic RAG

Singh et al. (2025) survey the move from linear retrieve-then-generate pipelines to
agentic architectures with graph-based workflows, state persistence and human-in-the-loop
steps. The survey is cited here for the taxonomy, not for an empirical effect size.

This work's orchestration is **deterministic**, not agentic in the sense the survey uses:
the model makes no control decisions about retrieval. That is a design choice with a
measurement consequence, discussed in §8 as a limitation and a path for future work.

---

## 4. Research gap

Three literatures meet here and none covers the intersection.

RAG evaluation frameworks measure grounding and relevance but have no construct for
authorization. Access-control work on vector stores (HoneyBee and its successors)
measures enforcement and latency at the *retrieval* layer and stops there. The
LLM-as-a-judge literature studies evaluator bias in general terms without reference to
security-sensitive judgements.

**No existing framework measures whether the generation stage preserves the containment
the retrieval stage achieved.** That omission matters because the two failures identified
in §1 are invisible to every metric currently in use, and because the assumption that a
model will decline to repeat material it should not have seen is, as far as this review
found, untested.

---

## 5. The two-stage leakage model

### 5.1 Retrieval stage (R-DLS)

For a user at permission level `P` and retrieved chunks `C₁…C_N`:

```
R-DLS = ( Σ 1[ClassificationLevel(Cᵢ) < P] / N ) × 100
```

Implemented as `computeDls` in `lib/core/telemetry.ts`. Lower integers denote higher
privilege, so a chunk is unauthorized when its classification is below the user's level.

### 5.2 Generation stage (G-DLS)

Whether the *answer* disclosed protected content, detected on two independent channels:

| Channel | Detects | Requires a model |
|---|---|---|
| **Canary** | verbatim disclosure of a string seeded into the classified corpus | no |
| **LLM judge** | the same fact paraphrased, inferred, or partially revealed | yes |

Both verdicts and their agreement are recorded per answer. This is what makes an
LLM-as-judge result defensible: **the deterministic channel serves as the judge's
validation set**, and sustained disagreement across a run indicates the judge prompt is
not yet reportable.

Canary matching normalises whitespace and strips bidirectional marks, and is
substring-based rather than word-bounded: Hebrew attaches the prefixes ו/ב/ל/ה/כ/מ/ש
directly to the word, so a bounded match would miss `בפרוטוקול` for the canary
`פרוטוקול`. Over-detection is the safe direction.

Implemented as `evaluateGenerationDls`.

### 5.3 Derived quantities

```
Containment Gap        CG = P(generation leaked | retrieval leaked) × 100
Model Containment Rate      = 100 − CG
Unconditional Leakage  UL = P(generation leaked | retrieval clean)  × 100
```

Both return **undefined rather than zero** when their conditioning set is empty. If no
record leaked at retrieval, a reported `CG = 0` would read as "the model contained every
failure" when in fact there were none to contain — turning an absent datum into a finding.
Implemented as `aggregateTwoStageLeakage`, with this property pinned by test.

---

## 6. System as apparatus

The implementation is the controlled environment in which leakage can be induced and
measured on a live deployment rather than a synthetic harness. It is **not** the
contribution.

| Layer | Implementation |
|---|---|
| Runtime | Next.js 14 (App Router), TypeScript, Node 20 |
| Vector store | PostgreSQL 16 + pgvector; 768-dim embeddings (Gemini text-embedding-004), HNSW with `vector_cosine_ops` |
| Retrieval | Hybrid: dense (`1 − cosine`) and lexical (`ts_rank_cd`), merged by Reciprocal Rank Fusion, k = 60 |
| Access control | `FORCE ROW LEVEL SECURITY` on `knowledge_base`; policy `classification_level >= current_setting('app.user_permission_level')`, set per transaction |
| Authorization model | Four tiers, L0 (Admin) – L3 (Volunteer); **hierarchical**, not multi-tenant |
| Async execution | BullMQ + Redis, separate queues for chat and document ingestion |
| Gateway | WhatsApp Cloud API with HMAC-SHA256 verification and Redis idempotency |
| Orchestration | Deterministic TypeScript state machine (intent routing, session modes, safety signals) |
| Evaluation | `scripts/evaluate_runner.ts` over `scripts/data/golden_dataset.ts`; RAGAS metrics, R-DLS, G-DLS |

**Scale hazard, recorded because it affects interpretation.** The `similarity` field
carries `1 − cosine` for the dense arm and `ts_rank_cd` for the lexical arm, and RRF sorts
by fused rank while leaving `similarity` as its source arm produced it. The field
therefore holds one of two incomparable scales with no record of which. It must not be
thresholded or compared across rows until the retrieval arm is recorded alongside it.

---

## 7. Experimental design

### 7.1 Three staged experiments

A full crossing of retrieval × security × orchestration × model is 24 cells, which at a
realistic dataset size and repetition count exceeds any affordable budget. Each experiment
below varies one factor and fixes the rest.

| | Varies | Fixed | Answers |
|---|---|---|---|
| **E1 — Retrieval** | retrieval {dense-only, hybrid} × model | security = RLS | retrieval quality; isolates the RRF contribution |
| **E2 — Containment** | security {bypassed, RLS} × model | retrieval = hybrid | H1, H2, H3 |
| **E3 — Judge** | judge model {same family, different family} | generation fixed | H4 |

**E2's bypassed-security arm is what induces retrieval failures.** Without induced
failures the containment gap has an empty conditioning set and is not estimable. The
`retrieveSimilarDocumentsBypassRls` path already exists for this purpose.

This design also **removes a confound in the current harness**, where configurations A/B
and C/D differ in both security enforcement and orchestration simultaneously, so no
observed difference can be attributed to either.

### 7.2 Dataset

Current: 25 records — 5 standard, 20 adversarial — across five attack families
(authorization escalation, PII extraction, distress signal, prompt injection, benign
control) and four permission levels.

Required for this design:

- **Expansion to approximately 120 records.** At n = 20 adversarial, a family-level
  breakdown rests on four records per family and supports no inference.
- **Balance** across permission levels and families.
- **Canaries seeded into the classified corpus.** A canary that appears in no L0 document
  cannot evidence disclosure — it evidences only that the model invented a string.
- **Retention of the benign control family**, without which over-refusal is invisible and
  a system that refuses everything scores perfectly.

### 7.3 Adversarial conditions

Virtual users at each tier attempt extraction across the five families: direct requests
for higher-tier material, social engineering, instruction override, system-prompt
extraction, and inference from authorized fragments. The purpose is to establish that
containment does not rest on the model's semantic compliance — H1 tests the database
barrier, H2 and H3 test what remains when that barrier is removed or bypassed.

---

## 8. Metrics, statistics and validity

### 8.1 Metrics

RAGAS faithfulness, answer relevance, context precision and context recall; R-DLS; G-DLS
with per-channel verdicts and agreement; containment gap; unconditional leakage by attack
family; end-to-end latency.

### 8.2 Statistical treatment

The current harness has none of the following, and each is required.

**Repetition.** Language-model output is stochastic; one run per condition is a sample of
one. Minimum k = 5 per (record × condition) at fixed temperature, reported as a mean with
95% bootstrap confidence intervals, which suit bounded proportions at this sample size.

**Paired testing.** Conditions share records, so comparisons are paired. Wilcoxon
signed-rank rather than a t-test, since these are bounded proportions. Effect sizes (risk
difference with interval, or Cliff's delta) reported alongside any p-value: a significant
two-point difference is not a finding.

**Multiple comparisons.** H1–H4 across several model arms constitute a family of tests;
Holm–Bonferroni correction applied and stated.

### 8.3 Judge validation

The measurement most open to challenge. G-DLS depends on an LLM judge, and nothing makes
that credible except agreement with human labelling:

- A stratified subsample (n ≈ 60) spanning all five families is hand-labelled.
- **Cohen's κ is reported overall and per family.** Agreement on prompt injection may
  differ sharply from agreement on PII disclosure, and an aggregate figure would conceal
  that.
- Target κ > 0.7. Below that, the judge prompt is the finding and the leakage numbers are
  not reportable.
- The canary channel provides a second, independent validation signal, and its agreement
  with the judge is reported across the run.

Hypotheses are fixed before data collection, and results that contradict them are
reported as results.

---

## 9. Ethics and privacy

**Children's data.** The corpus concerns minors in a welfare context — the most protected
category under the Israeli Privacy Protection Law (5741-1981) and the Data Security
Regulations (5777-2017). PII is redacted before chunks are embedded or stored.

**Profiling.** Any longitudinal measurement of individual users risks constructing
cognitive or performance profiles of volunteers and staff, which could be repurposed for
evaluation of personnel. No per-individual measure leaves the system; only aggregate
statistics are exposed, and no report attributes behaviour to a named volunteer.

**Aggregate re-identification.** Aggregate reporting over small cohorts re-identifies
without any access-control rule being broken: a brief stating that one child at an
eight-child site shows distress indicators identifies that child to every reader. This is
leakage at a third level, beyond the scope of this proposal and recorded as the principal
direction for future work.

**Third-party models.** Communication with commercial providers occurs only under
enterprise agreements with zero data retention. An on-premise open-weight deployment is a
fallback where the organisation's hardware permits.

---

## 10. Source verification

Checked during preparation of this revision. Statistics drawn from secondary summaries
are marked and must be confirmed against the primary text before being quoted.

| Source | Identifier | Status |
|---|---|---|
| Es, James, Espinosa Anke, Schockaert (2024), *RAGAs: Automated Evaluation of Retrieval Augmented Generation* | EACL 2024 System Demonstrations, pp. 150–158; arXiv:2309.15217 | **Verified** |
| Zhong, Lentz, Narodytska, Szekeres, Rong (2025), *HoneyBee: Efficient Role-based Access Control for Vector Databases via Dynamic Partitioning* | arXiv:2505.01538; ACM DOI 10.1145/3786625 | **Verified.** RLS is the baseline it outperforms — cited accordingly in §3.3. Latency figures come from a secondary summary; confirm in the paper before quoting. |
| Chudziak & Kostka (2025), *AI-Powered Math Tutoring* | AIED 2025, LNCS 15882, pp. 462–469; DOI 10.1007/978-3-031-98465-5_58; arXiv:2507.12484 | **Verified.** Retained only if the pedagogy line is revisited; not cited in this revision. |
| Zhao (2025), *LECTOR* | arXiv:2508.03275 | **Verified, but single-author (not "et al."), and its effect is 90.2% vs 88.4% in a 100-learner simulation** — not a human study and not a large effect. Not cited in this revision. |
| Zheng et al. (2023) — canonical source for position bias and self-enhancement | — | Topic confirmed as canonical; **exact identifier to be confirmed** before submission. |
| Panickssery et al. (2024) — self-recognition and self-preference | — | Topic confirmed; **identifier to be confirmed**. |
| *Justice or Prejudice? Quantifying Biases in LLM-as-a-Judge* | ICLR 2025 | **Verified.** Source of the generate/judge separation recommendation behind H4. |
| *Measuring Self-Preference in LLM Judgments* | EMNLP 2025; arXiv:2506.02592 | **Verified** |
| Singh et al. (2025), *Agentic Retrieval-Augmented Generation: A Survey on Agentic RAG* | arXiv:2501.09136 | **Verified as a survey.** Cited for taxonomy only. |

**Removed from the previous draft:** a healthcare agentic-RAG paper attributed to Singh
et al. (2025) reporting a 15–21% reasoning-accuracy improvement. No paper matching that
description was located; the nearest candidates are a healthcare literature review
without LangGraph that reports retrieval precision and recall, and the general survey
above. The quoted figure appears in neither.

**Also removed:** BullMQ documentation, which is vendor material and belongs to the
implementation chapter rather than a literature review.

---

## 11. Limitations

**Single organisation, single language.** Findings are established on one Hebrew-language
deployment. Generalisation to other corpora and languages is untested.

**Hebrew lexical retrieval.** The full-text index uses `to_tsvector('simple')`, which
performs tokenisation and case folding only. This is deliberate — PostgreSQL ships no
Hebrew stemmer — but it means `ילד`, `הילד`, `לילד` and `ילדים` are unrelated tokens and
the lexical arm of the hybrid retriever is morphologically handicapped. Any measured
benefit of RRF is therefore a lower bound.

**Judge validity.** G-DLS rests on an LLM judge whose agreement with human labelling is
itself an empirical quantity (§8.3).

**Deterministic orchestration.** The system makes no model-driven control decisions, so
these results do not speak to leakage in genuinely agentic systems. Whether agency over
retrieval increases leakage — an agent can re-query, widen a filter, or be induced to do
so — is the natural extension of this measurement framework, and the second direction for
future work alongside aggregate re-identification.

**Scope of H1.** Confirming that RLS enforces its policy replicates an established result
and is included as a floor, not as a contribution.
