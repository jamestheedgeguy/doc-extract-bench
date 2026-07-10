# doc-extract-bench

An open, reproducible benchmark of document-extraction APIs on public datasets:

- **[Kynth Core](https://api.kynth.studio)** — `/v1/invoice`, `/v1/receipt`, `/v1/statement`, `/v1/tables`
- **AWS Textract** — AnalyzeExpense, AnalyzeDocument (TABLES)
- **Google Document AI** — Invoice parser, Expense parser, Bank Statement parser, Form parser
- **Veryfi** — documents API (BYO keys)
- **LlamaParse / LlamaExtract** — LlamaCloud (BYO keys)

Four document types, five pinned datasets, deterministic metrics, and **every raw
vendor response committed** — so every number below can be re-derived offline by
anyone, with zero API keys.

## Results

<!-- RESULTS_START -->
_Run `pnpm run bench` then `pnpm report` to generate._
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
pnpm fetch --gt-sroie   # keyless: re-derives SROIE ground truth from the pinned source
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
| `KYNTH_API_KEY` | Kynth Core | [api.kynth.studio](https://api.kynth.studio) — 500 free credits/mo |
| `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` (+standard chain), `AWS_REGION` | AWS Textract | needs `textract:AnalyzeExpense`, `textract:AnalyzeDocument` |
| `DOCAI_PROCESSOR_INVOICE` / `_EXPENSE` / `_BANK_STATEMENT` / `_FORM` | Google Document AI | full processor resource names; auth via `GOOGLE_ACCESS_TOKEN` or `gcloud auth print-access-token` |
| `VERYFI_CLIENT_ID`, `VERYFI_API_KEY`, `VERYFI_USERNAME` | Veryfi | free tier = 100 docs/mo (receipts-only coverage) |
| `LLAMA_CLOUD_API_KEY` | LlamaParse / LlamaExtract | |
| `BANKSTATEMENTLY_API_KEY` | statement scoring | free — [bankstatemently.com/developers](https://bankstatemently.com/developers) |
| `MAX_RUN_USD` | cost cap | default 60 |

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

## License

MIT © Isaiah Kim. Dataset licenses belong to their owners — see
[`docs/methodology.md`](docs/methodology.md).
