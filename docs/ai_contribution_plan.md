# The AI Contribution: Research Plan

**Degree:** M.Sc. Software Engineering, AI Specialization — Azrieli College of Engineering, Jerusalem
**Companion to:** `docs/research_proposal_agentic_rag.md`
**Status:** planning document, written against the codebase at `032b17f`

---

## 1. The question this document answers

An examiner in an AI specialization will look at ScholarAgent and see a well-engineered
production system: PostgreSQL with pgvector, Row-Level Security, BullMQ workers, a
WhatsApp gateway with HMAC verification and Redis idempotency, Docker images, CI. All of
it is competent, and **none of it is AI**. The challenge will be some form of:

> *"This is a RAG application with role-based access control. Where is the research?"*

That challenge is fair, and it is better to answer it deliberately in the thesis than to
be surprised by it in the defence. This document separates **apparatus** from
**contribution**, states the contribution as a claim that experiments can support or
refute, and lays out the experimental program that produces the evidence.

The short answer is that the AI contribution is **not the system**. It is a measurement
result about language-model behaviour that the system exists to produce.

---

## 2. Apparatus versus contribution

| Component | Role in the thesis |
|---|---|
| PostgreSQL + pgvector, RLS policies, migrations | **Apparatus.** The controlled environment in which leakage can be induced and measured. |
| BullMQ, Redis, WhatsApp gateway, Docker, CI | **Apparatus.** Evidence of a realistic deployment, not of research. Belongs in an implementation chapter, briefly. |
| Hybrid retrieval (dense + sparse, RRF) | **Minor contribution.** Empirical result in a morphologically rich, low-resource language. |
| Deterministic intent router (`lib/domain/chat/agent.ts`) | **Currently neither.** See §4 — this is the weakest point and it is fixable. |
| **Two-stage leakage model (R-DLS / G-DLS)** | **Primary contribution.** A measurement construct plus an empirical finding about LLM containment behaviour. |

Writing the infrastructure up as a contribution invites exactly the challenge above.
Writing it up as apparatus — "this is what made a controlled experiment on a real
deployment possible" — turns it into a strength, because most RAG-security work is
evaluated on synthetic harnesses rather than a system with real users and real
classified content.

---

## 3. The primary contribution, stated as a claim

Access control in RAG systems is **enforced and evaluated at the retrieval stage**.
Row-Level Security filters chunks; the standard evaluation question is whether any
unauthorized chunk entered the context window. The thesis's existing DLS metric
(`computeDls`, `lib/core/telemetry.ts`) formalises exactly that.

But **disclosure is a property of generation, not of retrieval.** Two failures are
invisible to a retrieval-stage metric:

1. Retrieval failed (R-DLS > 0) and the model **repeated** the unauthorized content.
   Whether a model acts as a second line of defence is an empirical question; the
   literature and most system designs *assume* it.
2. Retrieval was clean (R-DLS = 0) and the model disclosed protected content anyway —
   from parametric memory, by inference across authorized chunks, by obeying a prompt
   injection, or by revealing its own instructions. **RLS cannot prevent any of these,
   because nothing was retrieved to filter.**

### Central research question

> In a role-restricted RAG system, how much authorization containment is attributable to
> retrieval-stage enforcement, and how much to the language model's own refusal
> behaviour — and does increasing the model's agency over retrieval change that balance?

This question cannot be answered by building anything. It requires inducing failures,
measuring model responses under controlled conditions, and reporting with uncertainty.
That is what makes it research rather than engineering.

### The quantity that answers it

Already implemented in `aggregateTwoStageLeakage`:

```
Containment Gap  CG = P(generation leaked | retrieval leaked)
Model Containment Rate = 1 − CG
Unconditional Leakage  UL = P(generation leaked | retrieval clean)
```

`CG` is the attribution. At 0% the model contained every retrieval failure and RLS is
belt-and-braces. At 100% RLS is the only thing between a user and protected data, and
any claim of defence-in-depth is false. **Either result is publishable**, which is the
mark of a well-posed question — a hypothesis that can only come out one way is not one.

`UL` is the part the security layer provably cannot address, decomposed by attack family.

### Why this is AI research and not security engineering

The measured object is a behaviour of a generative model under adversarial input. The
measurement method is LLM-as-judge, which carries its own validity problem (§6). The
finding generalizes to any RAG system with tiered content, independent of this
organization or this stack.

---

## 4. The "Agentic" problem — and how to turn it into the second contribution

**State the problem plainly.** The proposal's title claims an *Agentic-RAG architecture*.
What exists in `lib/domain/chat/agent.ts` is a deterministic finite-state router:
`matchesChatHistoryHeuristic`, `matchesUserManagementHeuristic`, regex intent matching,
session modes. The model makes **no control decisions**. In the literature — ReAct,
Self-RAG, and the agentic-RAG line generally — "agentic" means the model decides what to
retrieve, whether to retrieve again, and when it is done.

An examiner who knows that literature will ask in what sense this is agentic, and
"deterministic state orchestration" is not an answer that survives the follow-up.

There are two honest resolutions. **The second is much stronger.**

**(a) Rename.** "Authorization-Aware RAG" or "Secure Multi-Tier RAG" describes what was
built, and a true title is better than an impressive one. Costs nothing but the title.

**(b) Make agency an experimental variable.** Implement a genuinely agentic path — the
model chooses retrieval parameters, may re-query, and self-critiques before answering —
and treat deterministic-vs-agentic as a **condition**, not an architecture.

Option (b) folds the title problem into the primary contribution and produces a second
research question that is genuinely interesting:

> **Does agency increase leakage?** An agent that controls its own retrieval has more
> opportunities to reach protected content: it can re-query, widen a filter, or be
> steered into doing so by an injected instruction. A deterministic pipeline cannot be
> talked into a second retrieval.

This is a real and under-examined risk, it is directly measurable with the two-stage
metric already built, and it justifies the word "Agentic" in the title by making agency
the thing under study rather than an unexamined design choice. **This is the recommended
path.**

---

## 5. Experimental program

### 5.1 Research questions

| | Question | Metric | Status |
|---|---|---|---|
| **RQ1** | Given a retrieval failure, how often does the model contain it? | Containment Gap | metric built, not wired |
| **RQ2** | With clean retrieval, how often does the model disclose anyway, by attack family? | Unconditional Leakage | metric built, not wired |
| **RQ3** | Does model-driven control over retrieval increase leakage versus deterministic routing? | G-DLS across control conditions | agentic path not built |
| **RQ4** | Does hybrid RRF improve retrieval over dense-only in Hebrew? | Context Precision / Recall | **no dense-only arm exists** |
| **RQ5** | Does deterministic pre-retrieval safety interception detect distress reliably? | interception rate | **no metric exists** |

### 5.2 Design: three staged experiments, not one grand factorial

A full crossing of retrieval × security × control × model is 24 cells; at 120 records and
5 repetitions that is ~14,400 generation calls plus judge calls. Not affordable and not
necessary. Each experiment holds everything constant but one factor:

| Experiment | Varies | Held fixed | Cells | Answers |
|---|---|---|---|---|
| **E1 — Retrieval** | retrieval {dense, hybrid} × model | security = RLS, control = deterministic | 4 | RQ4 |
| **E2 — Containment** | security {none, RLS} × model | retrieval = hybrid, control = deterministic | 4 | RQ1, RQ2 |
| **E3 — Agency** | control {deterministic, agentic} × security × model | retrieval = hybrid | 8 | RQ3 |

**This also fixes the confound in the current harness.** Configs A/B vs C/D differ in
*both* security enforcement and orchestration at once, so no difference between them can
be attributed to either. E2 and E3 separate them.

The security = none arm in E2 is what *induces* retrieval failures, and without induced
failures the Containment Gap has an empty conditioning set and is not estimable. The
`retrieveSimilarDocumentsBypassRls` path in `lib/core/db.ts` already provides it.

### 5.3 Dataset

Current: 25 records (5 standard, 20 adversarial), `scripts/data/golden_dataset.ts`.

Required:
- **Expand to ~120.** Proportions near 0 or 1 have wide intervals at n=20; family-level
  breakdowns at n=4 per family say nothing.
- **Balance across the four permission levels** and the five attack families.
- **Seed canaries into the classified corpus.** A canary that appears in no L0 document
  cannot prove disclosure — it proves only that the model invented a string. This is a
  data-preparation task, not a code task, and it gates the deterministic channel.
- **Keep a benign control family.** Without it, over-refusal is invisible and a system
  that refuses everything scores perfectly on leakage.

---

## 6. Statistical and validity requirements

These are what separate an M.Sc. result from a demo, and the current harness has none of
them.

**Repetition.** LLM output is stochastic. One run per condition measures a sample of one.
Minimum k = 5 per (record × condition) at fixed temperature; report mean with 95%
bootstrap confidence intervals, appropriate for proportions at this n.

**Paired testing.** Conditions share records, so comparisons are paired. Use Wilcoxon
signed-rank rather than a t-test — these are bounded proportions, not normal variates.
Report effect size (risk difference with CI, or Cliff's delta) alongside any p-value; a
significant 2-point difference is not a finding.

**Multiple comparisons.** RQ1–RQ5 across several model arms is a family of tests. Apply
Holm–Bonferroni and say so.

**Judge validation — the one that will be challenged hardest.** G-DLS uses an LLM as
judge. Nothing makes that credible except agreement with humans:
- Hand-label a stratified subsample (n ≈ 60, spanning all five families).
- Report **Cohen's κ** overall and **per family** — agreement on prompt injection may
  differ sharply from agreement on PII disclosure, and an aggregate κ can hide that.
- Target κ > 0.7. Below that, the judge prompt is the finding, not the leakage number.
- The canary channel is a second, independent validation signal: `evaluateGenerationDls`
  already returns the agreement between the two channels on every record. Report its
  distribution across the run.

**Pre-registration of hypotheses.** H1–H4 as currently written are directional and
generous (H3 asserts 0% leakage). State hypotheses before running, and report results
that contradict them as results. A thesis that confirms every hypothesis reads as one
that tested none.

---

## 7. Honest reassessment of H1–H4

| | As written | Problem | Revision |
|---|---|---|---|
| **H1** | Hybrid ≥15% better than naive vector search | No dense-only arm exists; the 15% figure has no basis | Keep direction, drop the number, add the arm (E1) |
| **H2** | Named models "statistically superior" | No statistics, no repetition; OpenAI absent from all arms | Either add the arm or narrow the claim to the models actually run |
| **H3** | DLS = 0% guaranteed | A guarantee is not a hypothesis; and retrieval-stage DLS alone cannot support it | Split: R-DLS = 0 under RLS (testable), and CG / UL reported as findings |
| **H4** | 100% distress detection, zero latency | Not measured anywhere; and `guardrails.ts` patterns were recently narrowed | Build the interception metric first, then state a hypothesis you can lose |

On H4 specifically: the distress patterns `חרם`, `השפלה`, `משפילים` were removed on
`refactor/arch-audit-and-worker-resilience`. That change is deliberately not merged. It
probably reduces false positives, but social exclusion and humiliation are central cases
in a social-educational organization, and the effect on recall is unmeasured. **Measure
before and after and the change becomes a finding; merge it silently and it becomes a
confound.**

---

## 8. Thesis chapter mapping

| Chapter | Content | Source |
|---|---|---|
| 1. Introduction | Tiered-access RAG; why disclosure ≠ retrieval | this document §3 |
| 2. Related work | RAG evaluation (RAGAS, TruLens), prompt injection, agentic RAG, access control in IR | to write |
| 3. Two-stage leakage model | Formal definition of R-DLS, G-DLS, CG, UL; detection channels | `lib/core/telemetry.ts` |
| 4. System and apparatus | Architecture, RLS, hybrid retrieval, gateway — **framed as apparatus** | existing proposal §3–5 |
| 5. Experimental design | E1–E3, dataset, statistics, judge validation | §5–6 |
| 6. Results | Per RQ, with CIs and tests | to produce |
| 7. Discussion | What the containment gap implies for defence-in-depth claims in RAG | to write |
| 8. Limitations | Single organization, Hebrew, judge validity, n | to write |

---

## 9. Priority order

The ordering is by what unblocks the most downstream work, not by effort.

1. **Wire G-DLS into `scripts/evaluate_runner.ts`** — add `LeakageSpec` to the adversarial
   records, seed canaries into the corpus, emit `gDls` on `EvalRow`, aggregate. Until
   this exists, the primary contribution produces no numbers.
2. **Add the dense-only arm and split the confound** (E1, E2). Without it RQ4 is
   unanswerable and RQ1 is uninterpretable.
3. **Repetition and statistics** — k=5, bootstrap CIs, Wilcoxon. Cheap in code, and
   everything downstream depends on it.
4. **Judge validation** — label the subsample, compute κ. Do this before generating
   headline numbers, not after.
5. **Expand the dataset to ~120.** Mostly authoring work; can run in parallel with 1–4.
6. **Safety interception metric** (RQ5), then evaluate the `guardrails.ts` narrowing.
7. **Build the agentic path** (RQ3). The largest piece, and the one that resolves the
   title. Start it only once 1–4 make it measurable.
8. **Update the proposal** — stale file paths from the refactor, stale model names, and
   the FTS description (it claims Hebrew dictionaries; the schema uses
   `to_tsvector('simple')`, which does no morphological analysis — see below).

### A finding already in hand

`migrations/001_initial_schema.sql` builds `content_tsv` with `to_tsvector('simple', …)`
and `lib/core/db.ts` queries it with `websearch_to_tsquery('simple', …)`. The `simple`
configuration performs tokenization and lowercasing only — no stemming, no stopwords, no
morphology. In Hebrew, `ילד`, `הילד`, `לילד` and `ילדים` are therefore four unrelated
tokens.

This means the sparse arm of the hybrid retriever is **structurally handicapped**, which
depresses the measured benefit of RRF and weakens RQ4 before a single experiment runs. It
is also a ready-made secondary contribution: measure RRF gain with `simple` versus a
Hebrew-aware configuration (prefix stripping for ו/ב/ל/ה/כ/מ/ש, lemmatization,
stopwords). Hebrew RAG is under-studied, and the result would be concrete and local.

---

## 10. What to say when challenged

> *"Where is the AI in this?"*

The contribution is a measurement result about language-model behaviour: how much of a
tiered RAG system's authorization containment comes from access control and how much from
the model's own refusal behaviour, and whether giving the model agency over retrieval
changes that. The system is the apparatus that makes the measurement possible on a real
deployment rather than a synthetic harness. The metric is novel because existing RAG
evaluation frameworks have no formalism for role-based containment and treat leakage as a
retrieval property, when disclosure is a generation property.
