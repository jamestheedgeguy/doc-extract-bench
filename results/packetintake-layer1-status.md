# Layer 1 Packet Intake Status

Completed: 2026-09-16 20:16 MDT. The already-running benchmark was monitored only; no run was started and no process was killed. FinTabNet reached 100 raw outputs, and the benchmark process was no longer present on the final check. Its exit code was not captured.

## Final raw counts and cost

| Dataset | Raw outputs | Errors | Recorded model cost (USD) |
|---|---:|---:|---:|
| fatura | 100 | 1 | 0.5883030260 |
| sroie | 100 | 3 | 0.6093613852 |
| cord | 100 | 0 | 0.2192953944 |
| fintabnet | 100 | 0 | 0.4645849400 |
| **Total** | **400** | **4** | **1.8815447456** |

## Offline scoring

`pnpm replay` succeeded with exit code 0 and regenerated scored JSON under `results/scored/`.

- **fatura:** field accuracy `0.9798449612403101`; ANLS `0.9798449612403101`; failures `1`.
- **sroie:** field accuracy `0.8865979381443299`; ANLS `0.9590622524838947`; failures `3`.
- **cord:** item precision `0.7230215827338129`; recall `0.8007968127490039`; F1 `0.7599243856332704`; totals accuracy `0.9154929577464789`; failures `0`.
- **fintabnet:** TEDS `0.8583176488763068`; S-TEDS `0.8748486752104714`; failures `0`.

Scoring produced numbers for all four datasets. The scored outputs are `results/scored/packetintake-fatura.json`, `packetintake-sroie.json`, `packetintake-cord.json`, and `packetintake-fintabnet.json`.
