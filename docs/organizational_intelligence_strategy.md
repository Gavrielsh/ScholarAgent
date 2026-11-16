# From Support Bot to Organizational Sensing

**A strategy for turning the question stream into field intelligence**

Companion to `docs/research_proposal_agentic_rag.md` and `docs/ai_contribution_plan.md`
Written against the codebase at `032b17f`

---

## 1. The blind spot

Every social-service organization has the same structural problem, and "Person to Person"
is no exception. **Field knowledge dies in the field.**

A volunteer stands in front of a child who is being excluded, or aggressive, or silent,
and handles it as best they can. What they learned in that moment — that this keeps
happening at this club, that nobody taught them how to handle it, that the same child
came up three times this month — stays in their head.

Management learns about problems through formal reporting: periodic, sparse, and
systematically biased. People report what they believe they are supposed to report, after
the fact, in the register they think is expected. By the time a pattern reaches a
supervisor it is months old, and the cases that never got reported are invisible by
construction.

So the organization makes its most consequential decisions — where to send a social
worker, what to train people on, which site needs intervention — on the thinnest data it
has.

## 2. The insight

**The questions volunteers ask when they are stuck are the most honest sensor the
organization has, and nobody reads them.**

A question to the bot is unprompted, immediate, and sincere. Nobody asks a support bot a
question for appearances. They ask because they need help *now*, about something real, in
their own words. That is a fundamentally different data source from a reporting form, and
it already exists: `chat_history` has been accumulating every one of them since the
system went live, and nothing reads that table except the conversational context window.

### Why this works where reporting systems fail

Reporting systems fail for one reason: filling them in is a cost to the person doing it
and a benefit to someone else. Adoption decays, and the data that survives is the data
someone was made to produce.

**A help system produces the same data as a byproduct of giving value.** The volunteer
asks because it helps them. The organizational signal is free. That inversion is the
whole strategy — and it is why this is defensible rather than another dashboard nobody
feeds.

## 3. What the system becomes

Three capabilities, from one stream.

**Case tracking.** Link related conversations over time and across people. Today each
question is answered and forgotten. A case view would show that aggression at one club
came up from four different volunteers in two weeks — something no single volunteer could
know and no supervisor currently sees.

**Site diagnostics.** Establish a baseline rate of topics per site and detect deviation.
Not "there are problems" — every site has problems — but *this site, this month, is off
its own pattern*, which is the only comparison that means anything across sites of
different sizes and populations.

**Investment guidance.** Two distinct gaps, distinguishable in data the system already
produces:

- A **knowledge gap** is where retrieval confidence is persistently low — volunteers ask,
  and the knowledge base has nothing good to give. That is a missing document, and the
  system can name the topic.
- A **training gap** is where retrieval succeeds and the same person asks the same thing
  again weeks later. The answer existed and did not transfer. That is a workshop, not a
  document.

Telling those two apart is the difference between useful advice and a word cloud.

## 4. The hard problem — and why it completes the thesis

Here is what makes this research rather than a reporting feature.

The subjects are **children in a welfare context**: the most protected data category under
the Israeli Privacy Protection Law the proposal already commits to. PII is redacted at
ingestion. And yet case tracking inherently wants longitudinal identity, and aggregate
reporting re-identifies all by itself:

> A club has eight children. The weekly brief says *"one child at this site is showing
> distress indicators."* Every staff member at that site now knows which child.

No access-control rule was broken. The manager was fully authorized. The leak came from
the **aggregate**.

> **How do you build longitudinal, actionable organizational intelligence over a
> population you are legally and ethically forbidden to re-identify?**

### The arc this completes

This is the same construct the thesis already measures, at a third level:

| Level | Question | Status |
|---|---|---|
| **Retrieval** | Did unauthorized chunks enter the context window? | built — `computeDls` |
| **Generation** | Did the model disclose, even from clean context? | built — `evaluateGenerationDls` |
| **Aggregation** | Can an *authorized* reader re-identify an individual from reports? | **this document** |

Three levels of leakage in a tiered RAG system, measured with one coherent framework. The
third is where the product value lives, which means **the product and the research are the
same work** — not a feature bolted onto a thesis.

A thesis with that arc has a title that writes itself and a contribution no examiner will
mistake for engineering.

## 5. Research questions

| | Question | Why it is not obvious |
|---|---|---|
| **RQ-A** | What suppression threshold (k-anonymity) or noise level (differential privacy) is required before a site brief stops being re-identifying? | Depends on site size distribution; small clubs may be unreportable at any useful fidelity |
| **RQ-B** | What is the utility cost at each privacy level — does the brief still surface real anomalies? | The **privacy–utility frontier**. If the honest answer is "no useful report is safe for an 8-child site", that is a finding worth publishing |
| **RQ-C** | Can an adversarial authorized reader recover individual facts by **differencing** successive weekly reports? | Classic attack, very concrete here: week *N* says 12 incidents, week *N+1* says 13, and the reader knows who joined |
| **RQ-D** | Does question frequency actually track problem prevalence? | **The validity question the whole product rests on** — see §8 |

RQ-C is the strongest of these. It is a real attack, it is cheap to simulate against
synthetic cohorts, and it is exactly the kind of thing a privacy-aware system is assumed
to handle and usually does not.

## 6. What has to be built

Grounded in the current schema, in dependency order.

### 6.1 The missing dimension (blocker)

**There is no site.** `users.organization_id` is a loose `UUID` with no table behind it, no
foreign key, and nothing that populates it. Without a site dimension, "identify weaknesses
in a location" is not implementable at all.

Needs a `sites` table (name, region, cohort size, active range) and a membership relation
to `users`, with cohort size recorded — because cohort size is what every privacy
threshold in §5 is computed against.

### 6.2 Signal extraction

Structured extraction from Hebrew conversational text into a typed signal: topic
taxonomy, severity, whether a specific child is implicated (as a flag, never an
identity), and whether the volunteer's need was met. This is the NLP core — information
extraction from informal, code-switched Hebrew, which is itself under-served.

The taxonomy must be built *with* the organization's staff, not invented. A taxonomy
nobody recognizes produces reports nobody trusts.

### 6.3 Retrieval confidence capture

`audit_logs` records `retrieved_chunk_ids` and `latency_ms` but **not similarity scores**,
so "the knowledge base had nothing good for this" is not recoverable after the fact. One
column, and knowledge-gap detection becomes possible. Cheap, and blocks a whole capability
until done.

### 6.4 Aggregation with privacy controls

The layer where §4 is enforced: k-anonymity suppression, optional DP noise on counts, and
— critically — **the suppression itself must be reported** ("3 signals withheld: cohort
below threshold"). A silently suppressed cell is indistinguishable from an absent problem,
and a manager who cannot tell those apart will misread the brief in the worst direction.

### 6.5 Delivery and recommendation

Periodic brief to L0/L1. Every recommendation carries its evidence and its uncertainty.
See §8 — this is not decoration.

## 7. Build order

1. **Sites dimension.** Nothing downstream works without it.
2. **Retrieval-confidence column.** One migration, unblocks knowledge-gap detection.
3. **Signal extraction + taxonomy**, on historical `chat_history` — the backlog is already
   there, so this produces real output on day one instead of waiting weeks for data.
4. **Aggregation with k-anonymity.** Thresholds configurable, because RQ-A is the
   experiment that sets them.
5. **Brief generation**, to one pilot site, read by a real supervisor before it goes wide.
6. **RQ-C differencing attack**, simulated against synthetic cohorts.
7. **Recommendation layer** with confidence reporting.

## 8. Risks, stated honestly

**The validity risk is the serious one.** Question frequency is not problem prevalence. A
site whose volunteers ask more may have more problems — or newer volunteers, or better bot
adoption, or one talkative person. A brief that says "invest here" on a confounded signal
sends a social worker to the wrong club and leaves the right one unattended. **This product
can cause harm by being wrong, and that risk scales with how much managers trust it.**

Mitigation is not cosmetic: normalize per active volunteer and per tenure, report
confidence on every recommendation, and validate against whatever ground truth the
organization already has before anyone acts on a brief.

**Surveillance risk.** If volunteers believe their questions feed a management dashboard,
some will stop asking honestly — and the sensor degrades exactly where it matters most, on
the hardest cases. Mitigations: aggregate-only by construction, never individual-volunteer
attribution in any report, and transparency with volunteers from the start rather than
after someone discovers it. (Whether disclosure changes question behaviour is itself
measurable, though it needs real users and ethics approval — out of scope for the thesis,
worth naming as future work.)

**Legal.** Children's data in a welfare context. The privacy controls in §6.4 are not a
feature to add later; they gate the pilot.

**Scope.** This is a second thesis's worth of work if built in full. §7 is ordered so that
steps 1–4 alone produce a defensible contribution (RQ-A, RQ-B, RQ-C), with the
recommendation layer as product work beyond the thesis.

## 9. Why this is a thesis and not a product spec

The product question — *where should we invest?* — is answered by aggregation. The
research question — *what can be published about a protected population without
identifying them, and what does that cost in usefulness?* — has to be answered before the
product is safe to deploy at all.

That dependency is what makes this defensible. The privacy work is not an ethics section
appended to a system; it is the precondition for the system existing. And the finding
generalizes well past this organization: any tiered RAG deployment that reports in
aggregate over a small, protected population inherits exactly this problem.
