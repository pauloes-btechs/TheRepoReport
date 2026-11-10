/** Argument parsing and run-summary rendering for pipeline/run.ts (kept here so they are testable). */
import type { RunEditionResult } from './orchestrate';

export interface CliArgs {
  edition?: string;
  force: boolean;
  dryRun: boolean;
  /** Only resolve the edition and check whether it is already live. */
  checkOnly: boolean;
  model?: string;
  siteDir: string;
  stateFile: string;
  nextStateFile: string;
  workDir: string;
  configDir: string;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    force: false,
    dryRun: false,
    checkOnly: false,
    siteDir: '.work/site',
    stateFile: '.work/state/state.json',
    nextStateFile: '.work/state/next-state.json',
    workDir: '.work',
    configDir: 'config',
  };
  const valueFlags: Record<string, keyof CliArgs> = {
    '--edition': 'edition',
    '--model': 'model',
    '--site-dir': 'siteDir',
    '--state-file': 'stateFile',
    '--next-state-file': 'nextStateFile',
    '--work-dir': 'workDir',
    '--config-dir': 'configDir',
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    if (flag === '--force') args.force = true;
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--check-only') args.checkOnly = true;
    else if (flag in valueFlags) {
      const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      // Empty values (e.g. an unset workflow input) mean "not given".
      if (value !== '') (args as unknown as Record<string, unknown>)[valueFlags[flag]!] = value;
    } else {
      throw new Error(`Unknown argument: ${raw}`);
    }
  }
  return args;
}

const fmt = (v: number | string | boolean | undefined, unit = '') =>
  v === undefined || v === '' ? 'n/a' : `${v}${unit}`;

/** Markdown for $GITHUB_STEP_SUMMARY. Never includes secrets (none are in the summary object). */
export function renderSummaryMarkdown(result: RunEditionResult): string {
  const s = result.summary;
  const m = s.metrics ?? {};
  const lines = [
    `## TheRepoReport edition ${s.editionKey ?? '(unresolved)'}`,
    '',
    `**Outcome:** ${s.status}${s.reason ? ` — ${s.reason}` : ''}${s.dryRun ? ' (dry run, not deployed)' : ''}`,
    '',
  ];
  if (s.status === 'published' || s.status === 'dry-run') {
    lines.push(
      `- Stories: ${fmt(s.storyCount)} (watching ${fmt(s.watchingCount)}, skipped ${fmt(s.skippedCount)})${s.quiet ? ' — quiet edition' : ''}`,
      `- Summarization: ${fmt(s.summarization)}${s.model ? ` (${s.model})` : ''}`,
      `- Audio: ${s.audio?.available ? `${fmt(s.audio.bytes, ' bytes')}, ${fmt(s.audio.durationSec, ' s')}` : `unavailable — ${s.audio?.unavailableReason ?? 'unknown'}`}`,
      `- Archive: carried ${s.carriedEditions?.length ?? 0}, dropped ${s.droppedEditions?.length ?? 0}`,
      '',
    );
  }
  if (s.failedRepos && s.failedRepos.length > 0) {
    lines.push(`- Repos not scanned (cursors not advanced): ${s.failedRepos.map((f) => `${f.repo} (${f.reason})`).join(', ')}`, '');
  }
  lines.push(
    '| Metric | Value |',
    '|---|---|',
    `| GitHub API requests | ${fmt(m.githubRequests)} |`,
    `| GitHub rate remaining | ${fmt(m.githubRateRemaining)} |`,
    `| Repos scanned | ${fmt(m.reposScanned)} |`,
    `| Events collected | ${fmt(m.eventsCollected)} |`,
    `| Inference seconds | ${fmt(m.inferenceSeconds)} |`,
    `| Tokens / second | ${fmt(m.tokensPerSecond)} |`,
    `| Audio synthesis seconds | ${fmt(m.audioSeconds)} |`,
    `| Pipeline seconds | ${fmt(s.stageSeconds.total)} |`,
    `| Peak RSS (node) MB | ${fmt(s.memory?.peakRssMb)} |`,
    `| Peak system used MB | ${fmt(s.memory?.peakSystemUsedMb)} |`,
  );
  for (const [key, value] of Object.entries(s.infra ?? {})) lines.push(`| ${key} | ${fmt(value)} |`);
  lines.push('', '<details><summary>Stage timings (s)</summary>', '', '| Stage | Seconds |', '|---|---|');
  for (const [stage, secs] of Object.entries(s.stageSeconds)) if (stage !== 'total') lines.push(`| ${stage} | ${secs} |`);
  lines.push(`| total | ${fmt(s.stageSeconds.total)} |`);
  lines.push('', '</details>', '');
  return lines.join('\n');
}

/** Lines for $GITHUB_OUTPUT. */
export function renderGithubOutputs(result: RunEditionResult): string {
  return [
    `status=${result.status}`,
    `deploy=${result.deploy}`,
    `edition=${result.editionKey ?? ''}`,
    `site_dir=${result.siteDir}`,
    `next_state_file=${result.nextStateFile}`,
    '',
  ].join('\n');
}

/** Numeric/boolean timings exported by earlier workflow steps (see edition.yml). */
export function infraFromEnv(env: NodeJS.ProcessEnv): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  const map: Record<string, string> = {
    OLLAMA_INSTALL_SECONDS: 'ollamaInstallSeconds',
    MODEL_PULL_SECONDS: 'modelPullSeconds',
    MODEL_LOAD_SECONDS: 'modelLoadSeconds',
    PIPER_INSTALL_SECONDS: 'piperInstallSeconds',
    VOICE_DOWNLOAD_SECONDS: 'voiceDownloadSeconds',
  };
  for (const [envName, key] of Object.entries(map)) {
    const v = env[envName];
    if (v !== undefined && v !== '' && Number.isFinite(Number(v))) out[key] = Number(v);
  }
  if (env.MODEL_CACHE_HIT) out.modelCacheHit = env.MODEL_CACHE_HIT === 'true';
  return out;
}
