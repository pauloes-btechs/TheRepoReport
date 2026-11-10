# Costs

**Target: $0 recurring.** Every service below is used inside a free allowance. For each one this lists the limit that keeps it free and, once measured, how close real usage comes.

Limits were checked against GitHub's documentation on 2026-11-10 (links inline). GitHub changes these from time to time, so recheck the links if something starts billing.

## Itemized

| Service | What we use it for | Why it costs $0 | Limit that matters | Source |
|---|---|---|---|---|
| GitHub Actions minutes | 3 edition runs a day, plus CI and a monthly keepalive | "GitHub Actions usage is free for standard GitHub-hosted runners in public repositories." We only use `ubuntu-latest`. Larger runners **are** billed, so never switch to one. | Job max 6 h (we cap at 45 min). Public repo required. | [Billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage), [How Actions use is measured](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Actions limits](https://docs.github.com/en/actions/reference/actions-limits) |
| GitHub Pages | Hosts the site, JSON data, MP3s and the RSS feed | Free for public repositories | Published site **≤ 1 GB**. **Soft** bandwidth limit of 100 GB/month. The soft limit of 10 builds/hour "does not apply if you build and publish your site with a custom GitHub Actions workflow", which is how we deploy. Deployments time out after 10 minutes. | [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| Actions cache | Ollama model (`~/.ollama/models`), Piper voice, npm and pip caches | Separate 10 GB per-repository allowance. Billing only starts if the owner raises the cache limit above 10 GB. | 10 GB per repo. Older entries are evicted when full. A cache miss only costs time, never correctness. | [How Actions use is measured](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Actions limits](https://docs.github.com/en/actions/reference/actions-limits) |
| Actions artifacts | 7-day edition recovery copies, 1-day `next-state`, 7-day diagnostics, dry-run output, the Pages artifact | See note below | Free plan lists 500 MB artifact storage. Short retention keeps the stored total small. | [Actions limits](https://docs.github.com/en/actions/reference/actions-limits) |
| `GITHUB_TOKEN` API quota | Collecting releases, PRs, issues and advisories | Included | 1,000 REST requests/hour/repository. Secondary limits: 100 concurrent requests, 900 points/minute. | [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [Actions limits](https://docs.github.com/en/actions/reference/actions-limits) |
| Ollama | Local inference server on the runner | Open source (MIT), downloaded by the official install script | Runner CPU and RAM only (4 vCPU / 16 GB) | https://github.com/ollama/ollama |
| `qwen3:4b-instruct` (fallback `qwen3:1.7b`) | Headlines and explanations | Open weights, Apache-2.0 | ~2.5 GB / ~1.4 GB download, cached | https://ollama.com/library/qwen3 |
| Piper (`piper-tts`) | Offline text-to-speech | Open source, **GPL-3.0**. We run it as a separate program (`pip install` and command line). We don't link it into our code or ship it on the site, so its license doesn't extend to this repository. | — | https://github.com/OHF-Voice/piper1-gpl |
| Piper voice (`en_US-lessac-medium`) | The narrator voice | Free download from the Piper voices repository | **Each voice has its own license. TODO: confirm the lessac voice's model-card license before calling the audio redistributable.** | https://huggingface.co/rhasspy/piper-voices |
| FFmpeg | WAV concatenation, loudness normalization, MP3 encoding | Preinstalled on `ubuntu-latest` (installed from apt if not) | — | https://ffmpeg.org |
| Domain / TLS | `pauloes-btechs.github.io` | Provided by GitHub Pages | — | — |

**Artifact storage note.** GitHub's billing page frames storage costs around private repositories. It doesn't say outright that artifact storage is free for public repositories, so we couldn't confirm that. To be safe, this project stays inside the smallest published allowance (500 MB on the Free plan). It keeps only 7 days of edition copies plus 1-day state handoffs, and nothing else long-lived.

**Not used, on purpose:** paid LLM APIs, hosted TTS, databases, servers, CDNs, analytics, custom domains. If one of them ever becomes necessary, it has to be added here with its cost. Don't add one silently.

## Back-of-envelope ceilings (estimates, not measurements)

These follow from configuration, not from observed runs:

- **Audio per edition:** at most 12 min (`targetMinutes.max`) at ~64 kbps mono ≈ 12 × 60 × 64,000 / 8 ≈ **5.8 MB**.
- **Archive on Pages:** 7 days × 3 editions = 21 editions × 5.8 MB ≈ **122 MB** of audio, plus JSON and the frontend. That's roughly an eighth of the 1 GB site limit in the worst case.
- **Bandwidth:** 100 GB/month ÷ 5.8 MB ≈ 17,000 full-episode downloads a month before the soft limit. Every run also re-downloads the whole live archive (≤ ~122 MB) from Pages to carry it forward: ~90 runs × 122 MB ≈ **11 GB/month** of our own traffic in the worst case. That is the biggest single item to watch.
- **Actions minutes:** free on public standard runners, so the target of under 30 min per run (45 min cap) is about runtime, not money.

## Measured usage

> **Not yet measured.** The values below get filled in from the job summaries of the first real Actions runs (see `docs/BENCHMARKS.md`). Until then every cell is a placeholder. Don't quote these as results.

| Measurement | Limit | Run 1 | Run 2 | Run 3 | Headroom |
|---|---|---|---|---|---|
| Job wall clock (min) | 45 (cap) / 360 (GitHub) | TODO-measured | TODO-measured | TODO-measured | TODO |
| Ollama install (s) | — | TODO-measured | TODO-measured | TODO-measured | — |
| Model pull, cold / cached (s) | — | TODO-measured | TODO-measured | TODO-measured | — |
| Inference (s), tokens/s | `inferenceBudgetSeconds` 1200 | TODO-measured | TODO-measured | TODO-measured | TODO |
| Piper synthesis (s) | — | TODO-measured | TODO-measured | TODO-measured | — |
| GitHub API requests / remaining | 1,000 per hour | TODO-measured | TODO-measured | TODO-measured | TODO |
| Peak runner memory (MB) | 16 GB | TODO-measured | TODO-measured | TODO-measured | TODO |
| MP3 size (MB) / duration (min) | — | TODO-measured | TODO-measured | TODO-measured | — |
| Published site size (MB) | 1,024 | TODO-measured | TODO-measured | TODO-measured | TODO |
| Actions cache used (GB) | 10 | TODO-measured | TODO-measured | TODO-measured | TODO |
| Artifact storage (MB) | 500 (conservative) | TODO-measured | TODO-measured | TODO-measured | TODO |
| Pages bandwidth (GB/month) | 100 (soft) | Not observable directly; estimate from site size × runs + listener downloads | | | TODO |

How to fill it in: each run's job summary has a **Runner measurements** table and a pipeline metrics table. Cache size is under Actions → Caches. Artifact storage is under Settings → Billing (or the run pages).
