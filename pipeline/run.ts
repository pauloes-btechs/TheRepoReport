/**
 * CLI entry: `npx tsx pipeline/run.ts [--edition KEY] [--force] [--dry-run] [--check-only] [--model NAME]
 *   [--site-dir DIR] [--state-file FILE] [--next-state-file FILE] [--work-dir DIR] [--config-dir DIR]`
 *
 * Environment: GITHUB_TOKEN (never printed), SITE_URL, OLLAMA_URL, PIPER_VOICE,
 * FORCE_FALLBACK=1, FORCE_NO_AUDIO=1, ALLOW_EMPTY_ARCHIVE=1,
 * GITHUB_STEP_SUMMARY / GITHUB_OUTPUT (set by Actions).
 *
 * `--check-only` resolves the edition and checks the live manifest without loading
 * any stage module (used by the workflow to skip installing Ollama/Piper on re-runs).
 *
 * Exit codes: 0 published / dry-run / skipped, 1 failed.
 */
import { appendFile } from 'node:fs/promises';
import { SITE_URL } from '../shared/contracts';
import { infraFromEnv, parseCliArgs, renderGithubOutputs, renderSummaryMarkdown } from './publish/cli';
import { checkPublished, runEdition, type EditionDeps } from './publish/orchestrate';
import { createLogger } from './util/logger';

async function loadDeps(): Promise<EditionDeps> {
  const [collectMod, storiesMod, scoreMod, llmMod, scriptMod, audioMod, feedMod] = await Promise.all([
    import('./collect/index'),
    import('./stories/index'),
    import('./score/index'),
    import('./llm/index'),
    import('./script/index'),
    import('./audio/index'),
    import('./feed/index'),
  ]);
  return {
    collect: collectMod.collect,
    buildStories: storiesMod.buildStories,
    scoreStories: scoreMod.scoreStories,
    selectStories: scoreMod.selectStories,
    explainStories: llmMod.explainStories,
    buildScript: scriptMod.buildScript,
    narrate: audioMod.narrate,
    buildFeed: feedMod.buildFeed,
  };
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN || undefined;
  const logger = createLogger({ scope: 'edition', secrets: token ? [token] : [] });
  const siteUrl = process.env.SITE_URL || SITE_URL;

  if (args.checkOnly) {
    const check = await checkPublished({
      siteUrl,
      force: args.force,
      logger,
      ...(args.edition ? { editionOverride: args.edition } : {}),
    });
    process.stdout.write(
      `edition ${check.editionKey}: ${check.alreadyPublished ? 'already published' : 'not published yet'} (manifest ${check.manifest})` +
        `${check.proceed ? '' : ' — skipping'}\n`,
    );
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `edition=${check.editionKey}\nalready_published=${check.alreadyPublished}\nproceed=${check.proceed}\n`,
      );
    }
    if (!check.proceed && process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `## TheRepoReport edition ${check.editionKey}\n\n**Outcome:** skipped — already published.\n`);
    }
    return 0;
  }

  const deps = await loadDeps();
  const result = await runEdition(deps, {
    siteDir: args.siteDir,
    stateFile: args.stateFile,
    nextStateFile: args.nextStateFile,
    workDir: args.workDir,
    configDir: args.configDir,
    siteUrl,
    force: args.force,
    dryRun: args.dryRun,
    logger,
    infra: infraFromEnv(process.env),
    ...(args.edition ? { editionOverride: args.edition } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(token ? { token } : {}),
    ...(process.env.OLLAMA_URL ? { ollamaUrl: process.env.OLLAMA_URL } : {}),
    ...(process.env.PIPER_VOICE ? { voice: process.env.PIPER_VOICE } : {}),
  });

  const markdown = renderSummaryMarkdown(result);
  process.stdout.write(`${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, renderGithubOutputs(result));
  return result.status === 'failed' ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    createLogger({ scope: 'edition', secrets: process.env.GITHUB_TOKEN ? [process.env.GITHUB_TOKEN] : [] }).error('fatal', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  },
);
