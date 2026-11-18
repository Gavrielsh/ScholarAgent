# ScholarAgent — Retrieval Benchmark

Generated 2026-11-18T10:44:27.274Z

## Configuration

| Setting | Value |
|---|---|
| Queries scored | 21 of 30 |
| Repeats per query | 3 |
| Retrieval depth | top 10 |
| RRF k | 60 |
| R4 stage-1 candidates | 25 |
| R4 re-ranking judge | yes (LLM_PROVIDER=gemini) |
| Judged candidates | 600 of 600 |

## Experiment 1 — retrieval quality

Mean ± population standard deviation across repeats.

| Arm | Recall@3 | Recall@5 | Recall@10 | MRR | NDCG@5 |
|---|---|---|---|---|---|
| R1 — Sparse (PostgreSQL FTS, ts_rank_cd) | 0.000 ± 0.000 † | 0.000 ± 0.000 † | 0.000 ± 0.000 † | 0.000 ± 0.000 † | 0.000 ± 0.000 † |
| R2 — Dense (pgvector cosine) | 0.929 ± 0.175 | 0.976 ± 0.106 | 1.000 ± 0.000 † | 1.000 ± 0.000 † | 0.977 ± 0.048 |
| R3 — Hybrid RRF (k=60) | 0.929 ± 0.175 | 0.976 ± 0.106 | 1.000 ± 0.000 † | 1.000 ± 0.000 † | 0.977 ± 0.048 |
| R4 — Hybrid RRF + re-rank + adaptive cut | 0.944 ± 0.157 | 0.976 ± 0.106 | 1.000 ± 0.000 | 1.000 ± 0.000 | 0.980 ± 0.044 |

† Standard deviation is exactly 0 because the arm is deterministic SQL over a
fixed corpus — every repeat returns the same ranking. This is a statement about
determinism, not about reliability or confidence.

## Latency

Retrieval only. Query embedding is computed once per query and shared across
arms, so it is excluded here rather than charged to arms that need it. Percentiles
use the nearest-rank method with no interpolation, so each figure is an observed
measurement.

| Arm | P50 (ms) | P95 (ms) | Re-rank P50 (ms) | Errors |
|---|---|---|---|---|
| R1 — Sparse (PostgreSQL FTS, ts_rank_cd) | 2.0 | 3.0 | — | 0 |
| R2 — Dense (pgvector cosine) | 3.0 | 4.0 | — | 0 |
| R3 — Hybrid RRF (k=60) | 4.0 | 6.0 | — | 0 |
| R4 — Hybrid RRF + re-rank + adaptive cut | 4.0 | 5.0 | 8233.0 | 0 |

## Experiment 2 — cross-tier leakage

Each query runs under its own permission tier. A leak is any returned chunk whose
classification is more privileged than the asking tier. No LLM is involved, so
this is a direct and deterministic test of whether a retrieval strategy can
bypass row-level security.

| Arm | Leakage rate | Leaking observations | Unauthorised chunks |
|---|---|---|---|
| R1 — Sparse (PostgreSQL FTS, ts_rank_cd) | 0.00 | 0 / 90 | 0 |
| R2 — Dense (pgvector cosine) | 0.00 | 0 / 90 | 0 |
| R3 — Hybrid RRF (k=60) | 0.00 | 0 / 90 | 0 |
| R4 — Hybrid RRF + re-rank + adaptive cut | 0.00 | 0 / 90 | 0 |

All arms returned 0.00. Scope of that claim: it covers the *retrieval* stage
only, over the queries and corpus present at run time. It does not show the
model refuses to disclose material it was legitimately given, which is
generation-stage leakage and is measured separately with seeded canaries.

## Error analysis — five lowest-MRR queries

### STD-001 — mean MRR 0.750

- **Tier**: L2 (Staff)
- **Question**: מה התקרה היומית להחזר הוצאות נסיעה למתנדב, ועד מתי צריך להגיש את הבקשה?
- **Judged relevant chunks**: `71117656`(g2), `fcc1604f`(g1)
- **R1_sparse top 5**: nothing retrieved
- **R2_dense top 5**: `71117656`(g2), `fcc1604f`(g1), `3bf141f7`, `5a708cbf`, `177c1e78`
- **R3_hybrid_rrf top 5**: `71117656`(g2), `fcc1604f`(g1), `3bf141f7`, `5a708cbf`, `177c1e78`
- **R4_hybrid_reranked top 5**: `71117656`(g2), `fcc1604f`(g1), `3bf141f7`, `5a708cbf`, `177c1e78`

### STD-002 — mean MRR 0.750

- **Tier**: L2 (Staff)
- **Question**: מה גובה המלגה לסטודנטים וכמה שעות חונכות שבועיות היא דורשת?
- **Judged relevant chunks**: `177c1e78`(g2), `c509f917`(g1)
- **R1_sparse top 5**: nothing retrieved
- **R2_dense top 5**: `177c1e78`(g2), `c509f917`(g1), `2b93417f`, `48d782fe`, `3bf141f7`
- **R3_hybrid_rrf top 5**: `177c1e78`(g2), `c509f917`(g1), `2b93417f`, `48d782fe`, `3bf141f7`
- **R4_hybrid_reranked top 5**: `177c1e78`(g2), `c509f917`(g1), `2b93417f`, `48d782fe`, `3bf141f7`

### STD-003 — mean MRR 0.750

- **Tier**: L2 (Staff)
- **Question**: מה ערך השובר לציוד בית ספר או ביגוד חורף, ואיזה טופס צריך למלא?
- **Judged relevant chunks**: `48d782fe`(g2), `b6ca4f1c`(g1)
- **R1_sparse top 5**: nothing retrieved
- **R2_dense top 5**: `48d782fe`(g2), `177c1e78`, `71117656`, `fcc1604f`, `5a708cbf`
- **R3_hybrid_rrf top 5**: `48d782fe`(g2), `177c1e78`, `71117656`, `fcc1604f`, `5a708cbf`
- **R4_hybrid_reranked top 5**: `48d782fe`(g2), `177c1e78`, `71117656`, `fcc1604f`, `5a708cbf`

### STD-004 — mean MRR 0.750

- **Tier**: L2 (Staff)
- **Question**: מה מספר הטלפון של מוקד המתנדבים ובאילו שעות הוא פעיל?
- **Judged relevant chunks**: `3bf141f7`(g2), `2b93417f`(g1)
- **R1_sparse top 5**: nothing retrieved
- **R2_dense top 5**: `3bf141f7`(g2), `c509f917`, `5a708cbf`, `2b93417f`(g1), `71117656`
- **R3_hybrid_rrf top 5**: `3bf141f7`(g2), `c509f917`, `5a708cbf`, `2b93417f`(g1), `71117656`
- **R4_hybrid_reranked top 5**: `3bf141f7`(g2), `c509f917`, `5a708cbf`, `2b93417f`(g1), `71117656`

### STD-005 — mean MRR 0.750

- **Tier**: L2 (Staff)
- **Question**: אילו אירועי קהילה פתוחים מתקיימים במהלך השנה ומתי מתקיימות ההרצאות לקהל?
- **Judged relevant chunks**: `577f1315`(g2), `5a708cbf`(g2)
- **R1_sparse top 5**: nothing retrieved
- **R2_dense top 5**: `577f1315`(g2), `5a708cbf`(g2), `177c1e78`, `71117656`, `c509f917`
- **R3_hybrid_rrf top 5**: `577f1315`(g2), `5a708cbf`(g2), `177c1e78`, `71117656`, `c509f917`
- **R4_hybrid_reranked top 5**: `577f1315`(g2), `5a708cbf`(g2), `177c1e78`, `71117656`, `c509f917`

## Known limitations

1. **Pool bias.** Judgements exist only for chunks some arm retrieved, so recall
   is measured over the judged set and is an upper bound on true recall. Arms are
   comparable because all are scored against the same pool.
2. **`ts_rank_cd` is not BM25.** PostgreSQL full-text search has no BM25; R1 uses
   coverage-density ranking. Do not describe it as BM25.
3. **No Hebrew stemming.** `websearch_to_tsquery('simple', …)` does not stem, and
   Hebrew attaches ו/ב/ל/ה/כ/מ/ש directly to words, so R1's recall is
   structurally capped. This is a property of the language and the available
   dictionaries, and is much of why fusion helps.
4. **R4 is not a cross-encoder.** No local cross-encoder is available, so an LLM
   scores candidates pointwise. It is subject to self-preference bias when the
   same model generates answers elsewhere in the system, and to position bias,
   which the per-repeat shuffle seed is there to expose.
5. **Sample size.** 21 scorable queries is small. Differences
   between arms should be read with that in mind; this reports descriptive
   statistics and runs no significance test.
