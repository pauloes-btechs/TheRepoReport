# TheRepoReport

**Your personal AI-powered GitHub newsroom.** Three times a day TheRepoReport scans the public repositories you follow, groups raw activity into stories, ranks them with a transparent impact score, explains them for a beginner, narrates them into an MP3, and publishes everything to a static site and podcast feed.

- **Listen:** https://pauloes-btechs.github.io/TheRepoReport/
- **Podcast feed:** https://pauloes-btechs.github.io/TheRepoReport/feed.xml (episodes expire after 7 days)
- **Schedule:** 7:15 AM, 1:15 PM and 7:15 PM New York time
- **Cost:** $0 per month. GitHub Actions on a public repo, GitHub Pages, Ollama and Kokoro (speech) running inside the job. See [docs/COSTS.md](docs/COSTS.md).

No server and no paid API; nothing runs on your own computer.

## How it works

```
GitHub REST API ──► collect ──► stories ──► score ──► select ──► explain (Ollama) ──► validate
   (incremental,      (PR + issue +    (6-dimension     (threshold,     (qwen3:4b-instruct,     (claims checked
    ETags, cursors)    release +        rubric, every    already-        JSON schema,            against evidence;
                       advisory → one   point cited)     covered skip)   beginner level)         fallback template)
                       story)
                                                                                  │
                     GitHub Pages ◄── manifest + report + feed ◄── narrate (Kokoro + FFmpeg) ◄── script
                     (7-day archive carried forward each run)      (MP3 with chapters)
```

| Stage | Code | What it guarantees |
|---|---|---|
| Collect | `pipeline/collect/` | Only new activity since the last successful run. Failed repos keep their cursor. Never advances state on failure. |
| Stories | `pipeline/stories/` | One development = one story (PR ↔ issue ↔ release ↔ advisory). Status comes from API facts only; *merged* never means *released*. |
| Score | `pipeline/score/` | Security 25 · Breaking 20 · Capability 20 · Reliability 15 · Ecosystem 10 · Relevance 10. Points only on evidence; stars alone earn nothing. |
| Explain | `pipeline/llm/` | Repository text is untrusted. A validator rejects invented URLs, versions, CVE ids, dates and status overclaims, with one retry, then a deterministic fallback. |
| Script and audio | `pipeline/script/`, `pipeline/audio/` | 5–12 minutes when news warrants it, shorter on quiet days, never padded. Validated MP3 with chapters. |
| Publish | `pipeline/publish/` | Archive carried forward and pruned to 7 days. Aborts rather than publish a site that loses the archive. |
| Web app | `src/` | Static React app: player with chapters and transcript, ranked story cards with score breakdowns, archive, repositories, settings draft. |

## Configure

Production configuration lives in two version-controlled files:

- [`config/watchlist.json`](config/watchlist.json): repositories, category, priority (1–3), enabled, topics. With `includeStarred: true`, the public stars of `githubUser` are merged in at run time (config entries win, capped at `maxRepos`).
- [`config/editorial.json`](config/editorial.json): topic interests, rubric weights (must total 100), minimum score, max stories, target length, retention, narrator voice, Ollama model, inference budget, pronunciation lexicon.

The site's **Settings** page edits a *draft* of these files in your browser, shows a diff against what is deployed, and gives you a download or a link to GitHub's editor. Drafts change nothing until committed. The site never asks for a token.

To add the repositories you **watch** (this needs authentication, so it runs locally):

```bash
GITHUB_TOKEN=<your token> npm run import:watched -- --dry-run   # preview
GITHUB_TOKEN=<your token> npm run import:watched                # writes config/watchlist.json
```

## Develop and test

Requires Node 22. FFmpeg is needed for the audio tests.

```bash
npm ci
npm run typecheck
npm test                 # unit + integration tests
npm run eval             # editorial quality eval on recorded fixtures (add --live to call Ollama)
npx tsx scripts/dev-data.ts && npm run dev   # web app with local fixture data
```

Run an edition locally (needs Ollama, Kokoro or Piper, and FFmpeg; otherwise it degrades to the fallback paths):

```bash
GITHUB_TOKEN=<token> npx tsx pipeline/run.ts --dry-run --replay-hours 36
```

## Deploy and operate

Pages is set to deploy from GitHub Actions; no secrets are needed. Day-to-day operation, manual runs, the `state` branch, recovery and calibration are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

Manual run from the Actions tab (**Edition → Run workflow**) supports: edition override, force, dry run, model override, forced fallback, forced no-audio, and `replay_hours` (dry runs only) for calibrating scoring on a past window.

## Measured performance

From real runs on `ubuntu-latest` (4 vCPU, 16 GB, CPU only); details in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

| | |
|---|---|
| Whole job | about 9–10 min |
| GitHub API | about 130 requests for 21 repos (limit 1,000/hour) |
| `qwen3:4b-instruct` | about 7 tokens/s; about 60 s per story after output caps |
| Kokoro narration | about 0.4 s of compute per second of audio (2 vCPU); George and Heart alternate from edition to edition |
| Peak runner memory | about 5 GB of 16 GB |

## Licenses

Code: MIT. Piper (GPL-3.0) is run as a separate program, never imported. Narration uses Kokoro-82M (Apache-2.0 weights, run via kokoro-onnx, MIT); the Piper fallback voice `en_US-ljspeech-high` is trained on public-domain data ([docs/VOICES.md](docs/VOICES.md)). Qwen3 weights: Apache-2.0.
