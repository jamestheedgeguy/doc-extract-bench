# Methodology

This document fixes the rules of the benchmark. Everything here was decided
**before** the full vendor runs; the pre-registered subset commit
(`43e39eb`, "pre-registered subset ID lists") predates every full-run raw
response in `results/raw/`.

## Dataset selection criteria

A dataset is eligible if and only if:

1. it has **public, field-level ground truth** (or, for statements, a public
   scoring API against server-side ground truth);
2. its **license permits scripted download** for evaluation;
3. we use the **official test split**, or a **seeded subset chosen before any
   API call** (seed committed in `datasets/manifest.json`);
4. **no document is excluded after seeing results.** If a vendor fails on a
   document, that is a failed document, not a dropped one.

## Datasets

| Dataset | Pin | Subset rule |
|---|---|---|
| FATURA (Zenodo 8261508, CC-BY-4.0) | zip sha256 `c8bf2ee6…` | official `strat1_test.csv`; per template t: seeded shuffle (seed `20260710 + t`), take 2 → 100 docs across all 50 layouts |
| SROIE (HF `Voxel51/scanned_receipts`) | revision `3ddf1be…` | seeded shuffle (seed `20260710`) of all 712 annotated receipts, take 100 |
| CORD-v2 (HF `naver-clova-ix/cord-v2`, CC-BY-4.0) | revision `7f0115a…` | the FULL official test split (exactly 100) — no sampling |
| FinTabNet (HF `docling-project/FinTabNet_OTSL`) | revision `1fe37f0…` | seeded shuffle (seed `20260710`) of the official 10,397-table test split, take 100 |
| Bankstatemently Open Benchmark (GitHub, MIT) | commit `f7c989b…` | all statements published upstream (5 of 15; the rest are "coming soon" upstream) |

Dataset notes, fixed pre-hoc:

- **FATURA** annotations carry label text ("Invoice Date: 14-Apr-2022"). The
  deterministic GT mapping (label stripping, date parsing, last-amount
  extraction, currency detection) lives in `datasets/gt-mappers.ts`; derived GT
  is committed under `datasets/gt/fatura/`. FATURA has **no line-item text
  ground truth** (its TABLE annotation is bbox-only), so invoices are scored on
  header fields only. Fields the GT genuinely lacks (e.g. Template 1 has no
  printed seller name) drop out of scoring rather than counting for or against
  anyone. The mapping rules were finalized during a 5-document smoke validation
  **before** any full run; two mapper bugs fixed at that stage (4-digit amounts
  parsed as two numbers; "INVOICE ID" prefix not stripped) affected ground
  truth only, identically for all vendors.
- **SROIE** is used under the ICDAR-2019 competition terms: images are
  **script-downloaded only and never committed**; the derived GT
  ({company → merchant, date, address, total}) is likewise re-derived at fetch
  time (`pnpm fetch --gt-sroie`) and kept out of the repo.
- **CORD-v2** blurs merchant name and date in its images, so only **line items
  and the totals block** are scored (subtotal, tax, service charge, total).
- **FinTabNet** ground-truth HTML is rebuilt from the dataset's original
  FinTabNet structure tokens + cell content (the OTSL conversion published by
  IBM's Docling team preserves the original `html` annotation). We use this
  parquet conversion rather than the 3.2 GB `bsmock/FinTabNet.c` archive so a
  reproduction downloads ~290 MB; the underlying tables and annotations are
  FinTabNet's.
- **Bankstatemently** ground truth is **server-side**; we submit each vendor's
  parse to `POST api.bankstatemently.com/v1/benchmark/evaluate` (PDF sha256 +
  transactions) and report their `normalizedScore` **verbatim**. We never
  self-score statements. `parsedScore` is not reported because our canonical
  schema submits normalized values (ISO dates, plain numbers) as `originalData`,
  which would unfairly penalize vendors on raw-formatting comparison.

## Metrics — deterministic; no fuzzy matching in headline numbers

### Field normalization (`src/score/normalize.ts`)

- **Amounts** → parse to float. Comma/dot thousands and decimal conventions
  handled; a number consisting solely of 3-digit dot groups ("60.000",
  "1.234.567") is read as dot-grouped thousands — no currency in this benchmark
  has 3-decimal minor units. Match iff |pred − gt| ≤ 0.005.
- **Dates** → parse to ISO `YYYY-MM-DD`; exact match after normalization.
  Ambiguous all-numeric dates (`05/06/18`) are read **day-first**: every
  ambiguous date in the benchmark is from day-first locales (SROIE = Malaysia;
  FATURA GT prints day-first).
- **Strings** → NFKC, lowercase, strip punctuation, collapse whitespace; exact
  match.

A field is scored only when ground truth has a value for it (**GT-present**).
Missing prediction for a GT-present field = wrong. Headline = **micro-averaged
accuracy over GT-present fields**. ANLS (DocVQA-style normalized Levenshtein
similarity, threshold 0.5) is reported as a **secondary diagnostic column
only** — it never enters a headline number.

### Line items / transactions (`src/score/lineitems.ts`)

Greedy 1:1 alignment: candidate (GT, pred) pairs ranked by exact amount match
first, then description similarity, with deterministic index tie-breaks; each
item used at most once. An aligned item is **correct iff every GT-present field
matches** (description, quantity, unitPrice, amount) — no partial credit.
Report precision / recall / **F1 (headline for CORD)**, micro-aggregated over
all items in the dataset.

### Tables (`src/score/teds.ts`)

**TEDS** (Tree-Edit-Distance-based Similarity, Zhong et al. 2019) and
**S-TEDS** (structure only), computed by an exact tree-edit-distance
implementation ported to TypeScript (Zhang–Shasha with the PubTabNet cost
model). The port is pinned to the reference IBM PubTabNet Python implementation
by **22 committed fixture pairs whose expected values were produced by the
reference code** (`apted` + `metric.py` @ `8ffde90`); the TS port reproduces
the reference to 0 deviation (`pnpm test`, keyless). Vendors' table outputs are
rendered to minimal `<table>` HTML (`<td>` + row/colspan only; `<th>`
normalized to `<td>`); each dataset image contains exactly one table and only
the first detected table is scored.

### Statements

Reported **verbatim** from the Bankstatemently evaluation API: `normalizedScore.
{overall, fields.date, fields.description, fields.amount, fields.balance}`,
averaged over the 5 statements. n=5 is stated everywhere — this dataset is a
smoke-scale benchmark until upstream publishes the remaining 10 statements.

**Upstream status (2026-07-10):** their evaluator currently returns
`invalid_parameters — parsed ground truth transaction 0 is missing account.kind.
Regenerate benchmark ground truth` for **every** published statement hash, i.e.
the server-side ground truth is in a broken state. All vendor parses are
committed under `results/raw/*/bankstatemently/`; they will be submitted
unchanged when the evaluator is fixed, and the error responses are cached under
`results/raw/*/bankstatemently-eval/` when they occur.

### Latency

Wall-clock per document (upload → parsed response), reported as the median.
Compound statements use its async job flow (submit + poll at 3 s), so its
statement latency includes polling granularity. Latency is measured from one
machine (US-East residential) and is indicative, not a load test.

## Failures

A vendor call that still errors after 3 attempts (with backoff) is recorded as
a **failed document**: it stays in the denominator of nothing (field scoring
skips it) but is reported in the "Failures" column. Failed docs are never
retried in later runs unless the raw file is deleted deliberately.

## Vendor coverage in the published run

| Vendor | invoice | receipt | statement | tables |
|---|---|---|---|---|
| Compound Core | ✅ | ✅ | ✅ (parses; evaluator pending upstream) | ✅ |
| AWS Textract | ✅ AnalyzeExpense | ✅ AnalyzeExpense | — no product | ✅ AnalyzeDocument TABLES |
| Google Document AI | ✅ Invoice parser | ✅ Expense parser | ✅ Bank Statement parser (parses; evaluator pending upstream) | ✅ Form parser |
| Veryfi | ⏭ skipped — no account/credentials | ⏭ | ⏭ | — no product |
| LlamaParse | ⏭ skipped — no account/credentials | ⏭ | ⏭ | ⏭ |

Skips are credential-based, not selective: the adapters are implemented
(`src/adapters/veryfi.ts`, `src/adapters/llamaparse.ts`) and run for anyone who
exports the keys. Veryfi's free tier is 100 docs/month, which covers exactly
one receipt dataset per month (partial coverage would be labeled as such).

## Pricing (verified July 2026, list prices, US)

| Vendor | invoice | receipt | statement | tables | Minimums |
|---|---|---|---|---|---|
| Compound Core | $0.08/doc | $0.06/doc | $0.12/doc | $0.08/doc | none — success-only billing, 500 free credits/mo |
| AWS Textract | $0.01/page (AnalyzeExpense, first 1M) | $0.01/page | — | $0.015/page (TABLES) | none |
| Google Document AI | $0.01/page (Invoice parser) | $0.01/page (Expense parser) | $0.75/doc (Bank Statement parser, Lending) | $0.03/page (Form parser) | none |
| Veryfi | $0.16/doc | $0.08/doc | $0.25/doc | — | **$500/month platform minimum** (free tier: 100 docs/mo) |
| LlamaParse | (LlamaExtract, credit-priced) | (credit-priced) | (credit-priced) | $1.25 per 1,000 pages | free tier: 10k credits/mo |

Sources: aws.amazon.com/textract/pricing, cloud.google.com/document-ai/pricing,
veryfi.com/pricing, cloud.llamaindex.ai pricing page — all retrieved 2026-07.
Prices move; the benchmark's cost gate uses these numbers only to refuse
over-budget runs, not in any accuracy metric.

## What this benchmark does not do

- No PDF-native invoices (FATURA is images); vendors with PDF-specific paths
  aren't differentially exercised on invoices.
- No throughput/load testing; latency is single-machine, sequential.
- No human re-annotation: ground truth errors in upstream datasets affect all
  vendors equally and are left as-is (criterion 4).
