# Benchmarks

Real runs of `.github/workflows/edition.yml` on `ubuntu-latest` (4 vCPU, 16 GB RAM, no GPU) against the live watchlist (21 repositories: 12 from `config/watchlist.json`, 9 imported from public stars), 2026-11-10. Numbers come from each run's job summary.

## Runs

| # | Run | Kind | Model | Window | Outcome |
|---|---|---|---|---|---|
| 1 | [42852951583](https://github.com/pauloes-btechs/TheRepoReport/actions/runs/42852951583) | Production (manual) | `qwen3:4b-instruct` | first run, 36 h | Published `2026-11-10-morning`: 1 story, LLM-written |
| 2 | [42855440410](https://github.com/pauloes-btechs/TheRepoReport/actions/runs/42855440410) | Dry run, replay 36 h | `qwen3:4b-instruct` | 36 h | 1 story; request timed out at 180 s → fallback |
| 3 | [42855458326](https://github.com/pauloes-btechs/TheRepoReport/actions/runs/42855458326) | Dry run, replay 36 h | `qwen3:1.7b` | 36 h | 1 story; both attempts hit the 700-token cap → truncated JSON → fallback |
| 4 | [42859053123](https://github.com/pauloes-btechs/TheRepoReport/actions/runs/42859053123) | Dry run, replay 36 h, after tuning (#8) | `qwen3:4b-instruct` | 36 h | 3 stories, all accepted by the validator on the first attempt |
| 5 | [42861307273](https://github.com/pauloes-btechs/TheRepoReport/actions/runs/42861307273) | Dry run, replay 36 h, forced fallback + forced no audio | — | 36 h | 2 stories, labeled fallback; audio unavailable with reason |

## Stage timings (seconds)

| Stage | Run 1 | Run 4 |
|---|---:|---:|
| Ollama install | 67 | 69 |
| Model pull (2.5 GB) | 9 (cold) | 1 (cached) |
| Model load | 3 | 3 |
| Piper install | 6 | 5 |
| Collect (21 repos, ~935 events, 129 requests) | 86 | 69 |
| Stories + score + select | 0.4 | 0.4 |
| Explain | 180 | 266 |
| Narrate (Piper + FFmpeg) | 72 | 99 |
| Pipeline total | 338 | 435 |
| Job wall clock | ~490 | 567 |

## Model calls

Per-call numbers from the `Model call` log lines (added in #7).

| Run | Model | Prompt tokens / s | Output tokens / s | Result |
|---|---|---|---|---|
| 1 | 4B | (not yet logged) | ~1,000 output tokens at 5.7 tok/s | Accepted |
| 2 | 4B | — | timed out at 180 s | Fallback |
| 3 | 1.7B | 1,892 / 24.7 s | 700 / 101.8 s (cap) | Invalid JSON |
| 3 | 1.7B retry | 2,037 / 2.6 s (cached) | 700 / 105.2 s (cap) | Invalid JSON → fallback |
| 4 | 4B | 2,434 / 106.5 s (cold) | 192 / 29.4 s | Accepted |
| 4 | 4B | 1,870 / 28.7 s | 214 / 28.7 s | Accepted |
| 4 | 4B | 1,935 / 32.5 s | 268 / 36.7 s | Accepted |

**What changed between runs 1–3 and run 4 (#8):** JSON-schema `maxLength` on every field, a two-item glossary, brief-field instructions, Intermediate/Technical text only for High+ stories, and `num_thread` set to the runner's vCPU count (Ollama defaults to physical cores). Output dropped from about 700–1,000 tokens to about 200–270 per story, and throughput rose from 5.7 to 7.1 tokens/s. A story now costs about 60 s. The first call pays about 75 s extra to warm the prompt path.

## Model choice

| | `qwen3:4b-instruct` | `qwen3:1.7b` |
|---|---|---|
| Download | 2.5 GB | 1.4 GB |
| Output speed on runner | 5.7–7.1 tok/s | 6.8 tok/s |
| Valid, validated JSON on the same evidence | Yes (run 4: 3 of 3) | No (run 3: 0 of 2, truncated) |

The 1.7B model was no faster per token and didn't finish valid JSON within the original budget. It is a hybrid "thinking" model, and the reasoning tokens most likely ate the budget. **Decision: keep `qwen3:4b-instruct`**, accuracy first. Re-testing 1.7B with the new caps and thinking disabled is listed under next steps.

## Audio

| | Run 1 | Run 4 |
|---|---:|---:|
| Segments | 6 | 8 |
| Duration | 202 s | 297 s |
| MP3 size | 1.62 MB | 2.38 MB |
| Piper real-time factor | 0.33 | 0.31 |

The voice is `en_US-ljspeech-high`. In local testing on 2 vCPU, `lessac-medium` ran at a real-time factor of 0.08, so the high-quality voice costs about 4× more synthesis time. That's still well inside the budget.

## Scoring calibration

Run 2's candidate table showed 819 stories with only one at 35 or above. Release notes written as "Added …" / "Fixed …" bullets (Claude Code, Ollama and others) earned no capability or reliability points. #8 credits those bullets, and #9 joins security advisories with their patch releases. In run 4 the top of the table was:

| Score | Story | Outcome |
|---:|---|---|
| 44 | vitejs/vite v8.3.7 (patch for the RCE advisory) | selected |
| 40 | anthropics/claude-code v2.1.321 | selected |
| 38 | vitejs/vite RCE advisory | selected (merged with v8.3.7 after #9) |
| 33 | claude-code: Cowork 10 GB VM bundle degrades performance | watching |
| 33 | claude-code: responsible-disclosure security issue | watching |

Busy repositories with many open issues (claude-code) mostly land in **Worth watching**, not headlines. That's the intended behavior for proposals.

## Peak memory

4.7 GB (run 1) and 5.1 GB (run 4) used out of 16 GB, sampled every 5 s with `free -m` across the whole runner, including Ollama.
