# Operations

How TheRepoReport runs in production, how to drive it by hand, and how to recover when something breaks.

- Live site: https://pauloes-btechs.github.io/TheRepoReport/
- Podcast feed: https://pauloes-btechs.github.io/TheRepoReport/feed.xml
- Workflows: `.github/workflows/edition.yml` (three editions a day), `.github/workflows/keepalive.yml` (monthly), `.github/workflows/ci.yml` (PR checks)

## One-time setup (repository owner)

These need a person with admin rights; the workflow cannot do them itself.

1. **Pages source.** Settings → Pages → Build and deployment → Source: **GitHub Actions**. This also creates the `github-pages` environment.
2. **Workflow permissions.** No change needed. The workflows declare exactly what they need (`contents: write` to push the `state` branch, `pages: write` and `id-token: write` to deploy, `actions: write` for keepalive), which works with the repository default of read-only. Verified by the first production run on 2026-11-10.
3. **`github-pages` environment.** Settings → Environments → `github-pages` → Deployment branches and tags. Keep it at the default branch (`main`). Manual runs dispatched from any other branch will build but fail at the deploy job, which is expected: state is not advanced when deploy fails.
4. **Don't protect the `state` branch.** The workflow force-pushes a single commit to it every run. If you add a branch ruleset that covers all branches, exclude `state` from it (or allow force pushes for GitHub Actions).
5. **Nothing else.** No secrets are needed: the run uses the built-in `GITHUB_TOKEN`. Don't add a personal token to Actions.

The first scheduled or manual run finds no live manifest (HTTP 404) and no state, treats that as the first run, and publishes an archive with a single edition.

## Schedule and edition identity

Runs start at **7:15, 13:15 and 19:15 New York time**. The schedule uses `timezone: "America/New_York"`, so GitHub handles daylight-saving changes. The edition key (`YYYY-MM-DD-morning|afternoon|evening`) comes from the New York wall clock when the run starts (`shared/edition.ts`), not from which cron fired. A run that starts 50 minutes late is still the right edition. A run before 7:05 belongs to the previous evening.

- **Duplicate guard.** The first real step (`run.ts --check-only`) reads the live `data/manifest.json`. If the key is already published, the job ends successfully without installing Ollama or Piper, without deploying, and without touching state. Re-running a finished run is a no-op.
- **Concurrency.** `concurrency: { group: edition, cancel-in-progress: false }`. One run executes at a time. GitHub keeps at most one more run pending in the group, and a newer pending run replaces an older one.
- **Missed runs.** The collector's reporting window always starts at the last successful state, so the next run covers whatever a missed run would have reported.
- **Scheduled delays.** GitHub can start scheduled runs late when it is busy. Lateness changes nothing except publish time.

## What one run does

```
build job (≤45 min)
  checkout → npm ci → precheck (already published? stop here)
  → npm run build (fail fast on a broken frontend)
  → restore model cache → install Ollama → ollama serve → ollama pull <model> → save model cache
  → setup-python → pip install piper-tts → restore/download voice → verify ffmpeg
  → fetch state.json from the `state` branch (absent = first run)
  → npx tsx pipeline/run.ts --site-dir .work/site ...
       resolve edition → load config + state → read live manifest (abort if unreadable)
       → stage unexpired archive editions → collect → stories → score → select
       → explain (Ollama, validated, fallback) → script → narrate (Piper + FFmpeg)
       → write report.json / transcript.json / audio.mp3 / manifest.json / feed.xml / run-summary.json
       → write .work/state/next-state.json (not committed yet)
  → copy the built frontend (dist/) into .work/site
  → scripts/check-secrets.ts over dist/, the site and next-state (fails the job on any hit)
  → upload edition recovery artifact (retention 7 days) and next-state artifact
  → upload Pages artifact
deploy job        actions/deploy-pages (environment github-pages)
commit-state job  only if deploy succeeded: orphan commit of state.json, force-pushed to `state`
```

Every step that measures something writes to the job summary. That includes Ollama install time, model pull time (with cache hit or miss), model load time, Piper install time, inference seconds, tokens per second, Piper synthesis seconds, GitHub requests and remaining quota, job wall clock, peak runner memory (`free -m` sampled every 5 s), site size and MP3 size. The memory logs and timings are uploaded as a `diagnostics-*` artifact (7 days).

## Triggering manually

Actions → **Edition** → Run workflow, or with the GitHub CLI:

```bash
gh workflow run edition.yml                                        # same as a scheduled run
gh workflow run edition.yml -f edition=2026-11-10-evening          # build a specific slot
gh workflow run edition.yml -f force=true                          # replace an edition that is already live
gh workflow run edition.yml -f dry_run=true                        # build everything; no deploy, no state change
gh workflow run edition.yml -f model=qwen3:1.7b                    # try another Ollama model for this run
gh workflow run edition.yml -f force_fallback=true                 # skip the LLM; deterministic briefing, labeled "fallback"
gh workflow run edition.yml -f force_no_audio=true                 # simulate a Piper failure; edition says "no downloadable audio"
```

| Input | Effect |
|---|---|
| `edition` | Edition key override. Blank means derive it from the current New York time. Must match `YYYY-MM-DD-(morning\|afternoon\|evening)`. |
| `force` | Publish even if that key is live. The old copy is replaced, not duplicated. |
| `dry_run` | Writes to `.work/dry-run/` and uploads it as a `dry-run-*` artifact (7 days). Nothing is deployed and the state branch is untouched. |
| `model` | Ollama model for this run. The model cache key follows the name, so a new model is pulled cold once. |
| `force_fallback` | Sets `FORCE_FALLBACK=1`. The LLM is skipped and every story uses the deterministic template. The edition is labeled `summarization: "fallback"`. |
| `force_no_audio` | Sets `FORCE_NO_AUDIO=1`. Narration is skipped and the report has `audio.available: false` with a reason. The site falls back to browser speech. |

Local runs (needs Ollama, Piper and FFmpeg on your machine):

```bash
GITHUB_TOKEN=$(gh auth token) npm run edition -- --dry-run
npm run edition -- --check-only            # just resolve the edition key and check the live manifest
```

Other CLI flags: `--site-dir`, `--state-file`, `--next-state-file`, `--work-dir`, `--config-dir`. Environment: `SITE_URL` (defaults to the live URL), `OLLAMA_URL`, `PIPER_VOICE`, `ALLOW_EMPTY_ARCHIVE`.

## State

Durable memory is one file, `state.json`, on the orphan branch **`state`**. It holds per-repo cursors and ETags, the story registry (status and last-covered edition, pruned after 14 days without updates), the last successful edition key and the schema version.

- It is read at the start of a run (`git show FETCH_HEAD:state.json`). If the branch is missing, the run starts from an empty state.
- The run writes the next state to `.work/state/next-state.json`. The workflow commits it **only after the Pages deploy succeeds**, as a single orphan commit force-pushed to `state`, so the branch never grows history. The commit author and committer are `Pauloes Berhe <pauloes@btechs.io>`.
- If collection, the archive, the build or the deploy fails, the state branch is untouched. The next run repeats the same window.
- Repos the collector could not scan keep their previous cursor even when the rest of the run succeeds.

Inspect it:

```bash
git fetch origin state && git show origin/state:state.json | jq '.lastEditionKey, (.stories | length)'
```

## Recovery

| Symptom | What happened | What to do |
|---|---|---|
| Run failed at `collect` (GitHub 5xx, quota) | Last edition stays live, state unchanged | Nothing. The next run covers the gap. Re-run manually if you want the slot filled. |
| Run failed with "Live archive unavailable" | Pages, the CDN or the network was unreachable, or the manifest or a listed file was invalid. The run aborted **before** deploying, so the archive is intact. | Open the live `data/manifest.json` in a browser. If the site is up, re-run. If a single listed file is broken, fix it with a `force` re-run of that edition, if it is still within the 7-day window. |
| "Live manifest is missing (404) but state says ... was published" | The live site lost its data while state remembers publishing | Check Settings → Pages first. To start a fresh archive on purpose, set the repository variable `ALLOW_EMPTY_ARCHIVE=1` (Settings → Secrets and variables → Actions → Variables), run once, then **delete the variable**. Per-edition copies from the last 7 days are in each run's `edition-<key>` artifact if you need the files. |
| Deploy job failed | Pages deploy error or timeout | The state branch was not advanced. Re-run the workflow. The duplicate guard reads the live manifest, which does not yet contain the edition, so the run proceeds. |
| `commit-state` failed after a successful deploy | The site has the edition, but state is behind | The next run sees the key as published and skips. The run after that recomputes from the older cursors, which can repeat a story once. To fix it right away, download the run's `next-state` artifact (1 day) and push it with the same orphan-commit commands as in the workflow. |
| A bad edition went out | Content problem | Fix the cause, then re-run with `edition=<key>` and `force=true`. |
| Credential scan failed | Something token-shaped is in `dist/` or the site | Nothing was uploaded. Find the file named in the log, which reports the file, line and pattern but never the value. If a real token leaked into the repo, revoke it. |
| Need to reset everything | — | `git push origin --delete state`, set `ALLOW_EMPTY_ARCHIVE=1`, run, then delete the variable. |
| Scheduled runs stopped | Disabled after 60 days without repository activity | Actions → Edition → Enable workflow, then check that `keepalive.yml` is enabled (see below). |

## Keepalive

GitHub docs: "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days" ([docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)). The docs don't define "activity". Edition runs only force-push the non-default `state` branch, and we couldn't confirm that this counts, so we don't rely on it.

`keepalive.yml` runs on the 1st of every month at 14:23 New York time, and can also be run manually. It calls `gh workflow enable` for `edition.yml` and for itself, using `GITHUB_TOKEN` with `actions: write`. It makes no commits to `main`. Whether a call to "enable" resets GitHub's inactivity timer for an already-enabled workflow isn't documented. **Not verified yet.** If the schedule is ever disabled anyway, re-enable it in the Actions tab. Any normal commit to `main` also resets the clock.

## Changing the model or voice

- **Model:** edit `model` (and optionally `fallbackModel`) in `config/editorial.json` and merge to `main`. The model cache key is `ollama-models-<model>-v1`, so the first run with a new model pulls it cold. To try a model without committing, use the `model` dispatch input. `inferenceBudgetSeconds` bounds wall-clock inference. The LLM stage degrades to fewer stories, then a smaller model, then the template, rather than timing out.
- **Voice:** edit `voice` in `config/editorial.json` (for example `en_US-lessac-medium`). The workflow downloads it with `python -m piper.download_voices <voice> --data-dir .work/voices` and caches it under `piper-voice-<voice>-v1`. The pipeline gets the name in `PIPER_VOICE` and the directory in `PIPER_DATA_DIR` / `PIPER_VOICES_DIR`. Each voice has its own license; check its model card before switching.
- **Piper version:** `scripts/requirements-tts.txt` (`piper-tts>=1.3,<2`).
- **Busting a cache:** bump the `-v1` suffix in the cache key, or delete the cache under Actions → Caches.

## Rate limits

- `GITHUB_TOKEN` in Actions: **1,000 REST requests per hour per repository** ([docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). Three runs a day are far apart, so each run gets a fresh hour. Conditional requests (`If-None-Match` with stored ETags) that return 304 do not count against the primary limit when authorized. The collector logs request count and remaining quota. Both appear in the job summary and in `metrics` in every report.
- Secondary limits (100 concurrent requests, 900 points per minute) apply too. The collector backs off using the reset headers on 403/429.
- The live-site fetches for the archive go to `github.io`, not the API, and do not count.

## Podcast

Subscribe to `https://pauloes-btechs.github.io/TheRepoReport/feed.xml` in any podcast app that accepts a URL. **Episodes expire after 7 days** (`retentionDays` in `config/editorial.json`). Each run drops editions older than that from the site, the manifest and the feed. Apps that already downloaded an episode keep their copy, but its link stops working. Editions published without audio (Piper failure) appear on the site but not as playable episodes.

## Files this layer owns

| Path | Purpose |
|---|---|
| `pipeline/run.ts` | CLI and wiring of the real stage modules |
| `pipeline/publish/orchestrate.ts` | `runEdition(deps, options)` and `checkPublished()` |
| `pipeline/publish/archive.ts` | Live-manifest read, first-run rule, carry-forward and expiry |
| `pipeline/publish/assemble.ts` | Report and manifest builders |
| `pipeline/state/` | State load/save, 14-day pruning, coverage marking, cursor merge |
| `pipeline/util/` | Redacting logger, timing, memory sampling |
| `scripts/check-secrets.ts` | Publish-time credential scan |
| `scripts/import-watched.ts` | `npm run import:watched`: merge your watched repos into `config/watchlist.json` |
| `scripts/requirements-tts.txt` | Piper version pin for the workflow |

### Importing watched repositories

```bash
GITHUB_TOKEN=$(gh auth token) npm run import:watched -- --dry-run   # preview
GITHUB_TOKEN=$(gh auth token) npm run import:watched                # write config/watchlist.json
```

Only public repositories are added, as `category: "Watched"`, `priority: 2`, `enabled: true`. Existing entries are never changed and archived repos are skipped. The script prints a summary of what was added and skipped. Review the diff, then commit it through a pull request.
