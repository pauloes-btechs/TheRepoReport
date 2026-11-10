# Costs

**Target: $0 recurring.** Every service below is used inside a free allowance. For each one this lists the limit that keeps it free and, once measured, how close real usage comes.

Limits were checked against GitHub's documentation on 2026-11-10 (links inline). GitHub changes these from time to time, so recheck the links if something starts billing.

## Itemized

| Service | What we use it for | Why it costs $0 | Limit that matters | Source |
|---|---|---|---|---|
| GitHub Actions minutes | 3 edition runs a day, plus CI and a monthly keepalive | "GitHub Actions usage is free for standard GitHub-hosted runners in public repositories." We only use `ubuntu-latest`. Larger runners **are** billed, so never switch to one. | Job max 6 h (we cap at 45 min). Public repo required. | [Billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage), [How Actions use is measured](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Actions limits](https://docs.github.com/en/actions/reference/actions-limits) |
| GitHub Pages | Hosts the site, JSON data, MP3s and the RSS feed | Free for public repositories | Published site **≤ 1 GB**. **Soft** bandwidth limit of 100 GB/month. The soft limit of 10 builds/hour "does not apply if you build and publish your site with a custom GitHub Actions workflow", which is how we deploy. Deployments time out after 10 minutes. | [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| Actions cache | Ollama model (`~/.ollama/models`), Kokoro model, Piper voice, npm and pip caches | Separate 10 GB per-repository allowance. Billing only starts if the owner raises the cache limit above 10 GB. | 10 GB per repo. Older entries are evicted when full. A cache miss only costs time, never correctness. | [How Actions use is measured](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [Actions limits](https://docs.github.com/en/actions/reference/actions-limits) |
| Actions artifacts | 7-day edition recovery copies, 1-day `next-state`, 7-day diagnostics, dry-run output, the Pages artifact | See note below | Free plan lists 500 MB artifact storage. Short retention keeps the stored total small. | [Actions limits](https://docs.github.com/en/actions/reference/actions-limits) |
| `GITHUB_TOKEN` API quota | Collecting releases, PRs, issues and advisories | Included | 1,000 REST requests/hour/repository. Secondary limits: 100 concurrent requests, 900 points/minute. | [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [Actions limits](https://docs.github.com/en/actions/reference/actions-limits) |
| Ollama | Local inference server on the runner | Open source (MIT), downloaded by the official install script | Runner CPU and RAM only (4 vCPU / 16 GB) | https://github.com/ollama/ollama |
| `qwen3:4b-instruct` (fallback `qwen3:1.7b`) | Headlines and explanations | Open weights, Apache-2.0 | ~2.5 GB / ~1.4 GB download, cached | https://ollama.com/library/qwen3 |
| Piper (`piper-tts`) | Offline text-to-speech | Open source, **GPL-3.0**. We run it as a separate program (`pip install` and command line). We don't link it into our code or ship it on the site, so its license doesn't extend to this repository. | — | https://github.com/OHF-Voice/piper1-gpl |
| Kokoro-82M (`kokoro-onnx`) | The narrator voices (George and Heart) | Open weights, Apache-2.0; runtime MIT. Model files (~205 MB) cached by Actions | — | https://github.com/thewh1teagle/kokoro-onnx |
| Piper voice (`en_US-ljspeech-high`) | Fallback narrator voice | Free download from the Piper voices repository | Trained on LJ Speech, which is public domain. `lessac` voices are avoided: their dataset license is noncommercial. See [VOICES.md](VOICES.md). | https://huggingface.co/rhasspy/piper-voices |
| FFmpeg | WAV concatenation, loudness normalization, MP3 encoding | Installed from Ubuntu's apt repository each run (not preinstalled on the current `ubuntu-latest` image) | — | https://ffmpeg.org |
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

From real runs on 2026-11-10 (details and run links in [BENCHMARKS.md](BENCHMARKS.md)). Run 1 is the first production edition. Run 4 is a dry run replaying the same 36-hour window after the output-length tuning, so it is what a busy edition costs now.

| Measurement | Limit | Run 1 (production) | Run 4 (tuned replay) | Headroom |
|---|---|---:|---:|---|
| Job wall clock | 45 min cap (GitHub: 6 h) | ~8.2 min | ~9.5 min | Large. Inference budget is 20 min. |
| Ollama install | — | 67 s | 69 s | — |
| Model pull (2.5 GB) | — | 9 s cold | 1 s cached | — |
| Inference | 1,200 s budget | 180 s, 1 story | 266 s, 3 stories | About 60 s per story → ~15 stories fit |
| Tokens / second | — | 5.7 | 7.1 | — |
| Piper synthesis | — | 72 s for 3.4 min audio | 99 s for 4.9 min audio | — |
| GitHub API requests / remaining | 1,000 / hour | 129 / 4,867* | 129 / 4,466* | About 13% of the hourly limit per run |
| Peak runner memory | 16 GB | 4.7 GB | 5.1 GB | About 3× |
| MP3 size / duration | — | 1.6 MB / 3.4 min | 2.4 MB / 4.9 min | About 0.48 MB per minute |
| Published site size | 1 GB | 2.2 MB | 2.9 MB (dry run) | Full 21-edition archive ≈ 60–120 MB |
| Actions cache | 10 GB | Model ~2.5 GB + voice + npm (~40 MB) + pip | same | About 3× |

\* The token reported a 5,000/hour ceiling in practice; the documented `GITHUB_TOKEN` figure is 1,000/hour per repository, so headroom is computed against 1,000.

**Pages bandwidth** isn't observable directly. Our own carry-forward downloads are the archive size per run: at ~60–120 MB for a full week, that's 5–11 GB a month, well under the 100 GB soft limit.

**Total recurring cost: $0.** No paid service is used.

How to fill it in: each run's job summary has a **Runner measurements** table and a pipeline metrics table. Cache size is under Actions → Caches. Artifact storage is under Settings → Billing (or the run pages).
