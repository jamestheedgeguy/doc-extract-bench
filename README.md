# doc-extract-bench

An open, reproducible benchmark of document-extraction APIs on public datasets:

- **[Kynth Core](https://api.thecompound.tech)** — `/v1/invoice`, `/v1/receipt`, `/v1/statement`, `/v1/tables`
- **AWS Textract** — AnalyzeExpense, AnalyzeDocument (TABLES)
- **Google Document AI** — Invoice parser, Expense parser, Bank Statement parser, Form parser
- **Veryfi** — documents API (BYO keys)
- **LlamaParse / LlamaExtract** — LlamaCloud (BYO keys)

Four document types, five pinned datasets, deterministic metrics, and **every raw
vendor response committed** — so every number below can be re-derived offline by
anyone, with zero API keys.

Part of **[Toolproof](https://toolproof.thecompound.tech)**, the measurement layer for AI
agent tooling — nine indexes held to [one published
methodology](https://toolproof.thecompound.tech/methodology), with the conflicts named. This
benchmark is the only one of the nine whose headline numbers a stranger can fully
re-derive offline, which is not a coincidence: it is the one that scores our own product
against commercial competitors, so it is the one that needed the strongest guarantee.

## Results

<!-- RESULTS_START -->
_Last generated 2026-07-10 — every number below is recomputable offline from the committed raw responses via `pnpm replay && pnpm report`._

### Invoices — FATURA, n=100 (2 per each of 50 layouts)

| Vendor | Field accuracy | ANLS (diagnostic) | Median latency | Failures |
|---|---|---|---|---|
| Kynth Core | **99.4%** | 99.4% | 12.8s | 0/100 |
| AWS Textract | **92.2%** | 92.2% | 1.8s | 0/100 |
| Google Document AI | **93.1%** | 93.8% | 2.9s | 0/100 |

### Receipts — SROIE test subset, n=100 (merchant / date / address / total)

| Vendor | Field accuracy | ANLS (diagnostic) | Median latency | Failures |
|---|---|---|---|---|
| Kynth Core | **88.8%** | 93.9% | 3.1s | 0/100 |
| AWS Textract | **68.8%** | 83.1% | 2.1s | 0/100 |
| Google Document AI | **52.8%** | 66.2% | 2.3s | 0/100 |

### Receipts — CORD-v2 full official test split, n=100 (line items + totals)

| Vendor | Line-item F1 | Precision | Recall | Totals accuracy | Median latency |
|---|---|---|---|---|---|
| Kynth Core | **41.9%** | 38.9% | 45.4% | 67.1% | 3.9s |
| AWS Textract | **77.1%** | 73.8% | 80.6% | 95.5% | 2.5s |
| Google Document AI | **36.6%** | 30.8% | 45.0% | 82.2% | 3.0s |

### Tables — FinTabNet test subset, n=100 (TEDS against ground-truth HTML)

| Vendor | TEDS | S-TEDS (structure only) | Median latency | Failures |
|---|---|---|---|---|
| Kynth Core | **0.791** | 0.819 | 23.4s | 14/100 |
| AWS Textract | **0.836** | 0.891 | 2.5s | 0/100 |
| Google Document AI | **0.365** | 0.423 | 2.6s | 0/100 |

### Bank statements — Bankstatemently Open Benchmark, n=5 (all published statements)

| Vendor | Parses cached | Status |
|---|---|---|
| Kynth Core | 5/5 | evaluation pending (upstream) |
| Google Document AI | 5/5 | evaluation pending (upstream) |

_Statements are scored exclusively by the [Bankstatemently evaluation API](https://github.com/bankstatemently/bank-statement-parsing-benchmark) (server-side ground truth). At the time of this run their evaluator returned an internal ground-truth error (`parsed ground truth transaction 0 is missing account.kind`) for every published statement PDF, so scores are pending an upstream fix. Our parses are committed under `results/raw/*/bankstatemently/` and will be submitted unchanged once the evaluator is fixed. AWS Textract has no bank-statement product._

<!-- RESULTS_END -->

Vendors that are missing from a table were skipped for that run — never silently:
the runner prints an explicit reason (no credentials, or no product for that doc
type). AWS Textract has no bank-statement product; Veryfi has no generic table
product; Veryfi and LlamaParse were skipped in the published run because this
project holds no accounts with them (see BYO keys below — PRs with their raw
responses are welcome).

## Reproduce the numbers (zero keys)

Every vendor's verbatim responses live in `results/raw/`. Re-score them offline:

```bash
pnpm install
pnpm exec tsx scripts/fetch.ts --gt-sroie   # keyless: re-derives SROIE ground truth
pnpm replay             # re-scores all committed raw responses
pnpm report             # regenerates results/latest.json + the README tables
pnpm test               # TEDS implementation vs Python-reference fixtures
```

## Run the benchmark yourself (BYO keys)

```bash
pnpm fetch    # downloads + sha256-verifies all datasets (~1 GB; images are never committed)
pnpm select   # verifies the committed pre-registered subsets
pnpm run bench # = tsx src/run.ts — runs every vendor you have credentials for
```

The runner **refuses to start** if the projected spend exceeds `MAX_RUN_USD`
(default $60) and prints a per-vendor cost table first. Vendors without
credentials are skipped, not failed.

| Env var | Vendor | Notes |
|---|---|---|
| `KYNTH_API_KEY` | Kynth Core | [api.thecompound.tech](https://api.thecompound.tech) — 500 free credits/mo |
| `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` (+standard chain), `AWS_REGION` | AWS Textract | needs `textract:AnalyzeExpense`, `textract:AnalyzeDocument` |
| `DOCAI_PROCESSOR_INVOICE` / `_EXPENSE` / `_BANK_STATEMENT` / `_FORM` | Google Document AI | full processor resource names; auth via `GOOGLE_ACCESS_TOKEN` or `gcloud auth print-access-token` |
| `VERYFI_CLIENT_ID`, `VERYFI_API_KEY`, `VERYFI_USERNAME` | Veryfi | free tier = 100 docs/mo (receipts-only coverage) |
| `LLAMA_CLOUD_API_KEY` | LlamaParse / LlamaExtract | |
| `BANKSTATEMENTLY_API_KEY` | statement scoring | free — [bankstatemently.com/developers](https://bankstatemently.com/developers) |
| `MAX_RUN_USD` | cost cap | default 60 |

### One-time Google Document AI setup

Document AI has no default processors — create the four pretrained processors
once in your GCP project, then export their resource names:

```bash
gcloud services enable documentai.googleapis.com --project <your-project>

TOKEN=$(gcloud auth print-access-token)
for T in INVOICE_PROCESSOR EXPENSE_PROCESSOR BANK_STATEMENT_PROCESSOR FORM_PARSER_PROCESSOR; do
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
    "https://us-documentai.googleapis.com/v1/projects/<your-project>/locations/us/processors" \
    -d "{\"type\":\"$T\",\"displayName\":\"bench-$T\"}"
done
# each response's "name" is the processor resource name →
#   export DOCAI_PROCESSOR_INVOICE="projects/<num>/locations/us/processors/<id>"
#   and likewise _EXPENSE, _BANK_STATEMENT, _FORM
```

All four processor types are GA with `allowCreation: true` — no allowlist
required. The adapter authenticates with `GOOGLE_ACCESS_TOKEN` if set,
otherwise it shells out to `gcloud auth print-access-token`.

## Design (why you can trust these numbers)

1. **Pinned datasets** — every source is pinned to an immutable revision/DOI with
   per-file sha256 in [`datasets/manifest.json`](datasets/manifest.json); `pnpm fetch` verifies before use.
2. **Pre-registered subsets** — the seeded document ID lists in
   [`datasets/subsets/`](datasets/subsets/) were committed **before any vendor API call**
   ([`43e39eb`](https://github.com/kyisaiah47/doc-extract-bench/commit/43e39eb)); no document
   was added or removed after seeing results.
3. **Committed raw responses** — `results/raw/<vendor>/<dataset>/<docId>.json`,
   verbatim. Scoring is a pure function of these files + committed ground truth.
4. **Deterministic metrics** — exact matching after type-aware normalization;
   no fuzzy matching in any headline number (ANLS appears as a labeled
   diagnostic only). Full metric spec: [`docs/methodology.md`](docs/methodology.md).
5. **Keyless CI re-scoring** — every PR re-scores the committed responses and
   re-runs the TEDS fixture tests ([`.github/workflows/score.yml`](.github/workflows/score.yml)).

Kynth Core is our own product — this benchmark exists because we want to be
measured in public, under rules fixed before the measurements. If you see a
methodological problem, open an issue; scoring changes are applied to **all**
vendors via replay.

## Datasets

| Doc type | Dataset | n | License / note |
|---|---|---|---|
| invoice | [FATURA](https://zenodo.org/records/8261508) (Zenodo, DOI 10.5281/zenodo.8261508) | 100 | CC-BY-4.0; 2 per each of 50 layouts, official test split |
| receipt | [SROIE](https://huggingface.co/datasets/Voxel51/scanned_receipts) (ICDAR 2019) | 100 | script-download only — images and GT are **never** committed here |
| receipt | [CORD-v2](https://huggingface.co/datasets/naver-clova-ix/cord-v2) | 100 | CC-BY-4.0; full official test split; merchant/date are blurred upstream → items+totals only |
| tables | [FinTabNet](https://huggingface.co/datasets/docling-project/FinTabNet_OTSL) (Docling OTSL conversion) | 100 | CDLA-Permissive (FinTabNet); GT HTML from original annotations |
| statement | [Bankstatemently Open Benchmark](https://github.com/bankstatemently/bank-statement-parsing-benchmark) | 5 | MIT; all statements published upstream to date; server-side GT |

## Citing this benchmark

Every number here is readable as JSON with no key and no account, under CC BY 4.0.
If you quote one, quote the URL it came from — a figure whose source a reader cannot
open is an assertion, which is the thing this repository exists not to be.

The results file itself, regenerated by `pnpm replay && pnpm report`:

```
https://raw.githubusercontent.com/kyisaiah47/doc-extract-bench/main/results/latest.json
```

The same figures through the Toolproof read API, alongside the other eight indexes:

```
https://toolproof.thecompound.tech/api/v1/indexes/doc-extract-bench
```

A citation line, if you need one:

```
doc-extract-bench — document-extraction APIs scored on pinned public datasets, with
every raw vendor response committed. Toolproof,
https://toolproof.thecompound.tech/api/v1/indexes/doc-extract-bench (CC BY 4.0).
```

**This benchmark mints no README badge, and that is deliberate.** Seven of the nine
indexes under Toolproof publish one, because their subject is a maintainer's own
repository and the measurement is a result they would display. This one scores
commercial vendors against each other on a run they do not control — a badge for it
would be a competitor comparison wearing a maintainer's clothes. A badge that can only
be used against its subject is not a measurement product. The numbers are published in
full instead; anyone may re-derive and republish them.

If you maintain something the other indexes DO measure — an agent tool, a skills
repository, an AGENTS.md, a starter kit, a shadcn registry — one call tells you which
readings exist and hands you the line to paste:

```
curl https://toolproof.thecompound.tech/api/v1/subjects/<owner>/<repo>
```

## License

MIT © Isaiah Kim. Dataset licenses belong to their owners — see
[`docs/methodology.md`](docs/methodology.md).
