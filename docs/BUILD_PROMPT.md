# TheRepoReport — Build Prompt (v2)

## Mission

Build **TheRepoReport**: a fully automated, zero-recurring-cost GitHub newsroom. Three times a day it scans the public repositories I follow, groups raw activity into stories, ranks them with a transparent impact score, explains them at a college-freshman level, narrates them into an MP3, and publishes everything to a static site I can open on my phone and press Play.

It should feel like a personal tech news network, not a GitHub activity dashboard.

Build the real application. No mockups, no placeholder data, no "architecture proposals."

## Fixed facts (already verified — do not re-litigate, do re-check if a step fails)

| Item | Value |
|---|---|
| Repository | `github.com/pauloes-btechs/TheRepoReport` (exists; contains only `LICENSE`) |
| Live URL | `https://pauloes-btechs.github.io/TheRepoReport/` — set the Vite `base` to `/TheRepoReport/` |
| Commit identity | Author **and** committer: `Pauloes Berhe <pauloes@btechs.io>`. No AI co-author or "generated with" trailers anywhere (commits, PR bodies, README). |
| Runner | `ubuntu-latest`, public repo: 4 vCPU, 16 GB RAM, ~14 GB disk, no GPU |
| LLM | Ollama, `qwen3:4b-instruct` (2.5 GB). Fallback candidate: `qwen3:1.7b` (1.4 GB) |
| TTS | Piper from the Open Home Foundation (`OHF-Voice/piper1-gpl`), installed with `pip install piper-tts`; voices via `python -m piper.download_voices`. Engine is GPL-3.0; each voice has its own license |
| Scheduling | GitHub Actions `schedule` supports a `timezone:` field next to `cron:` (since March 2026). Use `timezone: "America/New_York"`; do not hand-roll DST logic |
| Stack | React + TypeScript + Vite, Tailwind CSS, Vitest, Node scripts for the pipeline, FFmpeg, GitHub Pages |

## Hard constraints

1. **$0 recurring.** Public-repo Actions minutes, GitHub Pages, local inference, offline TTS. No paid API, database, server, or inference provider. If something can't be done for free, ship the best free alternative and document the tradeoff — never add a paid service silently.
2. **No always-on machine.** Production runs entirely on GitHub-hosted runners.
3. **No heavyweight memory.** No vector DB, embeddings, RAG store, fine-tuning, or chat memory. Ollama is a stateless analyst; a small JSON state file is the only memory.
4. **Public repositories only.** No private source data ever reaches the published site.
5. **No secrets in the browser or in git.** Tokens live in Actions secrets only.
6. **No fake UI.** Every button works; every number on screen comes from real pipeline output.
7. **Never invent news.** No fabricated features, statuses, dates, or outcomes. Quiet day → short edition that says so.

## Design decisions the original brief left open (resolved here)

These are the places where requirements collide. Implement them as written unless measurement proves one unworkable; if so, document why and what replaced it.

### D1. Where the seven-day archive lives
Pages artifact deploys replace the whole site, audio must stay out of git history, and Actions caches can be evicted. So:

- Each run downloads the currently published `data/` tree (manifest, reports, MP3s, feed) from the live Pages URL, drops anything older than 7 days, adds the new edition, and deploys the merged result as a new Pages artifact.
- If the live site is unreachable or the manifest fails validation, **abort before deploying** — never publish a site that wipes the archive. Exception: first-ever run (no manifest exists yet).
- Also upload each edition as a workflow artifact with `retention-days: 7` as a recovery copy.

### D2. Where durable state lives
A dedicated orphan branch `state` holding one file, `state.json`, rewritten as a **single amended, force-pushed commit** so history never grows. It contains: per-repo cursors and ETags, story registry (ID, status, last-covered edition; pruned at 14 days), last successful edition key, schema version.

- State is written **only after** the Pages deploy succeeds.
- Raw GitHub responses (≤48 h) and the Ollama model go in `actions/cache` — helpful, never required.

### D3. Schedule and edition identity
- Crons: `15 7 * * *`, `15 13 * * *`, `15 19 * * *` with `timezone: "America/New_York"`, plus `workflow_dispatch` (inputs: edition override, dry-run, model override).
- The edition is derived from New York wall-clock time when the run starts, not from which cron fired. Edition key = `YYYY-MM-DD-{morning|afternoon|evening}`.
- If that key is already published, exit cleanly (no duplicate). The reporting window is always "since the last successful state," so a missed run is absorbed by the next one.
- `concurrency: { group: edition, cancel-in-progress: false }`.
- Scheduled workflows in public repos are disabled after 60 days without repository activity. Verify whether `state`-branch pushes count; if not, add a keepalive and document it.

### D4. Who decides what
| Decision | Owner |
|---|---|
| Which events are candidates | Deterministic filters |
| Story grouping / dedup | Deterministic (linked PR ↔ issue ↔ release ↔ advisory references, then title similarity) |
| Development status | Deterministic, from API facts only |
| Impact score | Deterministic rubric over evidence signals |
| Headline, explanations, analogies, script | Ollama |
| Whether the LLM's text is allowed out | Deterministic validator |

The LLM never sets a score or a status. It only explains evidence it was handed.

### D5. Settings: what is real
- **Production config** (`config/watchlist.json`, `config/editorial.json`, version-controlled): watchlist with category/priority/enabled, topic interests, rubric weights, minimum score threshold, target length, max stories, Piper voice, retention days.
- **Local-only preferences** (browser `localStorage`): theme, playback speed, default explanation level, client-side filters.
- The Settings page edits a **draft** of the production config, shows a diff against what is deployed, and offers "Download JSON" and "Open in GitHub editor" (a link to the file's edit page). Label clearly: drafts do nothing until committed. The page never asks for a token.
- "Import starred" in the browser uses the unauthenticated public endpoint for a username. "Import watched" requires authentication, so it is a documented local CLI script (`npm run import:watched`, reads a token from the environment), not a browser feature.

### D6. Three explanation levels on a CPU budget
Generate Beginner for every story (it drives the audio). Generate Intermediate and Technical only for stories above the "Notable" threshold, in the same structured call. Lower-ranked stories show the Beginner text plus raw evidence links.

## Pipeline (one run)

1. Resolve edition key; exit if already published.
2. Load config and `state.json`.
3. **Collect** incrementally per repo: releases, merged PRs, notable open PRs, security advisories, notable issues/discussions. Use ETags / `If-None-Match`, `since` cursors, pagination, and stable event IDs. Budget against the Actions `GITHUB_TOKEN` limit of 1,000 requests/hour per repository; log request count and remaining quota. Back off on 403/429 using the reset headers.
4. **Normalize and group** events into stories with stable story IDs. A PR that merges and later ships in a release is one story whose status advances.
5. **Classify status:** Proposed (open PR/issue) → In development (active PR with recent commits/reviews) → Merged → Released (appears in a published release or tag notes) → Confirmed deployed (only with explicit evidence). Merged never implies available to users.
6. **Score** (maximums, awarded only on evidence):

   | Dimension | Max |
   |---|---:|
   | Security and safety | 25 |
   | Breaking change / compatibility | 20 |
   | New capability | 20 |
   | Reliability and performance | 15 |
   | Ecosystem significance | 10 |
   | Personal relevance (my topics and repo priority) | 10 |

   Bands: 90–100 Critical · 75–89 Major · 55–74 High · 35–54 Notable · 0–34 Routine.
   Each awarded point records the signal that earned it (advisory severity, semver major bump, `BREAKING` marker, labels, dependents, etc.). Star count alone earns nothing. Each story stores a one-line "ranks above the next story because…" derived from the dimension deltas, and an evidence-confidence rating (High / Medium / Low) based on how many independent primary sources agree.
7. **Select** stories above the threshold, capped by config, and skip stories already covered whose status has not changed.
8. **Explain with Ollama.** Per story (batch small related ones): a trimmed evidence bundle (titles, bodies truncated, release-note excerpts, labels, URLs) → JSON constrained by a schema via Ollama's `format` parameter. Fields: headline, what happened, previous situation, what changed, why it matters, what happens next (confirmed vs. speculative, labeled), glossary of terms introduced, optional analogy, intermediate and technical notes (per D6).
9. **Validate.** Reject or repair output when: JSON fails the schema; any URL is not in the evidence set; any version number, CVE ID, or date is absent from the evidence; the text asserts a status stronger than the classifier's; the text contains instruction-like or off-topic content. One retry with the error fed back, then fall back to a deterministic template for that story and mark it.
10. **Write the script** in broadcast order: greeting matched to the edition → top headlines → lead story → remaining stories by score → why this matters → worth watching (proposed and unresolved items) → closing takeaways. Target 5–12 minutes; scale down on quiet days. Run a pronunciation pass (config-driven lexicon for acronyms, repo names, version strings).
11. **Narrate.** Piper synthesizes each segment to WAV; FFmpeg concatenates with short pauses, loudness-normalizes, and encodes mono MP3 (~64 kbps). Segment durations produce chapter start times. Validate the MP3 (decodes, duration within bounds, non-silent).
12. **Publish** per D1: `data/manifest.json`, `data/editions/<key>/{report.json, transcript.json, audio.mp3}`, `feed.xml`, and the built frontend.
13. **Commit state** per D2. Emit a run summary with metrics (see Measurement).

### Untrusted input
Everything fetched from GitHub is data, never instructions. Wrap it in clearly delimited blocks, tell the model so, strip control characters and HTML comments, truncate aggressively, and rely on the validator — not the prompt — as the actual defense. Include prompt-injection fixtures in the test suite.

### Fallbacks
| Failure | Behavior |
|---|---|
| Ollama fails or exceeds its time budget | Deterministic source-grounded briefing; edition labeled "fallback summarization"; continue to audio |
| Piper fails | Publish the written edition, flag "no downloadable audio"; the site offers browser speech synthesis for that edition |
| GitHub API down or quota exhausted | Keep the last edition live, log, exit non-zero, do not advance state |
| Nothing newsworthy | Short "quiet period" edition; no manufactured headlines |
| Live archive unreachable | Abort before deploy (D1) |

Time budgets: job `timeout-minutes: 45`; target total under 30. Give inference a wall-clock budget and degrade (fewer stories → smaller model → template) rather than time out.

## Frontend

Mobile-first, dark and light themes, accessible (keyboard, focus states, ARIA labels on player controls, sufficient contrast), real loading, empty, and error states. It reads only the static JSON the pipeline publishes.

- **Home:** latest edition with a prominent player; today's three edition slots (published / pending / missed); top headlines; ranked story cards; security and release alerts; worth watching; recently active repos; last successful update time.
- **Story card:** headline, repo, score and band, status, confidence, timestamp, topic labels, plain-English explanation, GitHub evidence links, expandable technical notes, expandable score breakdown with the per-dimension signals and the "ranks above" line.
- **Player:** play/pause, restart, ±15 s skip, speed, scrubber, chapter list with per-story jump, transcript that follows the current chapter, MP3 download, Media Session metadata and handlers, persistent across page navigation.
- **Repositories:** watchlist with recent stories per repo; filter by topic, priority, repo.
- **Archive:** seven days by date and edition with audio, transcript, and stories; expired editions vanish because the manifest no longer lists them.
- **Settings:** per D5.
- **Podcast:** `feed.xml` (RSS 2.0 + iTunes tags, enclosures with byte length and duration, stable GUIDs). State plainly in the UI and README that episodes expire after seven days.

## Editorial quality loop

- `editorial/instructions.md` (versioned) plus 3–5 exemplar reports.
- `npm run eval` scores output over fixtures with this rubric, using source-grounded checks rather than the model grading itself:

  | Dimension | Weight | How it is checked |
  |---|---:|---|
  | Factual accuracy | 30% | Validator pass rate; claims traceable to evidence |
  | Story selection | 25% | Ranking vs. hand-labeled expected order on fixtures |
  | Beginner clarity | 20% | Readability score, undefined-jargon count |
  | Practical impact | 15% | Presence and specificity of "why it matters" |
  | Narration and brevity | 10% | Length vs. target, pronunciation-lexicon coverage |

- Report selection quality and explanation quality separately.

## Tests

Vitest unit and integration tests with recorded fixtures, plus one Playwright smoke test against the built site. Cover: API auth headers and pagination; rate-limit backoff; watchlist parsing; incremental cursors; dedup and story lifecycle; scoring and its breakdown; status classification (merged ≠ released); validator (including injection fixtures); Ollama schema handling, timeout, and fallback; MP3 validation; RSS validity; edition-key resolution across both DST transitions; seven-day pruning; archive carry-forward and the abort-before-wipe rule; state written only after deploy; duplicate-edition guard; a scan that no token appears in built assets.

Fixtures: critical security advisory in a small repo, routine commits in a popular one, open proposal, merged-but-unreleased feature, PR + issue + release for one change, API 5xx and 403 rate-limit, quiet day, malicious README/PR body.

## Delivery workflow

### Phases (each lands as its own pull request)
1. **Foundation** — scaffold, config schema, CI workflow (lint, typecheck, test, build), collector with fixtures.
2. **Intelligence** — normalization, grouping, lifecycle, scoring, selection.
3. **AI** — Ollama client, schemas, validator, fallback, script builder, eval harness.
4. **Narration** — Piper + FFmpeg, chapters, MP3 validation, RSS.
5. **Interface** — all pages and the player, built against real pipeline output from phases 1–4.
6. **Automation** — edition workflow, Pages deploy, archive carry-forward, state branch, retention.
7. **Proof** — real scheduled-style runs on Actions, benchmarks, docs, cost assessment.

### Parallel workstreams
After Phase 1 fixes the shared contracts (`src/shared/types.ts`, JSON schemas for config, state, manifest, report), run agents in parallel with strict file ownership:

| Agent | Owns | Phases |
|---|---|---|
| Pipeline | `pipeline/collect`, `pipeline/stories`, `pipeline/score` | 1–2 |
| AI | `pipeline/llm`, `pipeline/validate`, `editorial/`, `eval/` | 3 |
| Audio | `pipeline/audio`, `pipeline/feed` | 4 |
| Frontend | `src/` (app) | 5 |
| Ops | `.github/workflows`, `scripts/`, `docs/` | 6–7 |
| Reviewer | reads every PR diff cold before merge; owns nothing | all |

Agents never edit another agent's directories; contract changes go through a small PR of their own first.

### Git rules
- Branch per phase or workstream (`phase-N-name`), pull request into `main`, CI green, then **squash-merge** and delete the branch. No direct pushes to `main` after the scaffold PR.
- Conventional commit subjects. PR body: what changed, how it was tested, measured numbers where relevant.
- Identity as in Fixed facts. Verify with `git log --format='%an <%ae> | %cn <%ce>'` before every push.
- One-time setup the build should do itself where the token allows, otherwise list as manual steps: enable Pages with source "GitHub Actions"; workflow permissions `contents: write`, `pages: write`, `id-token: write`.

## Measurement (Phase 7 — required before calling it done)

From at least three real Actions runs against my actual watchlist, record in `docs/BENCHMARKS.md`: GitHub API requests and remaining quota, Ollama install + model load time (cold and cached), inference time and tokens/second, Piper time, total runtime, peak memory, MP3 size and duration, published site size, cache size, failures. Benchmark `qwen3:4b-instruct` against `qwen3:1.7b` on the same evidence and choose on accuracy first, speed second.

`docs/COSTS.md` itemizes every service at $0 with the limit that keeps it there (Actions on public repos, Pages 1 GB site / 100 GB monthly bandwidth soft limits, cache 10 GB) and how close the measured usage comes.

## Done means

- The live URL loads on phone and desktop and shows my real watchlist.
- Three editions are scheduled; at least one scheduled (not manual) run has published successfully.
- I can play, pause, seek, jump by story, change speed, and download an edition's MP3.
- Every story shows its score breakdown, status, confidence, and working GitHub evidence links.
- Proposed, merged, and released are distinguished correctly in a real edition.
- A second run carried the first run's edition forward; pruning is proven by test.
- A forced Ollama failure and a forced Piper failure each produced the documented fallback edition.
- State advanced only on success; a re-run of the same edition was a no-op.
- All tests and the eval pass in CI.
- Nothing in the repo or built site contains a credential.

Do not claim completion from mock data or a successful frontend build.

## Final report

Repository tree; live URL; links to the merged PRs and the Actions runs used as evidence; test and eval results; measured performance; cost assessment; known limitations and recommended next steps. State plainly anything that was not verified.
