import { describe, expect, it } from 'vitest';
import { infraFromEnv, parseCliArgs, renderGithubOutputs, renderSummaryMarkdown } from './cli';
import type { RunEditionResult } from './orchestrate';

describe('parseCliArgs', () => {
  it('parses --replay-hours', () => {
    expect(parseCliArgs(['--dry-run', '--replay-hours', '36'])).toMatchObject({ dryRun: true, replayHours: '36' });
  });

  it('parses flags and values, treating empty values as unset', () => {
    expect(parseCliArgs(['--edition', '2026-11-10-evening', '--force', '--dry-run', '--model=qwen3:1.7b', '--site-dir', 'out', '--edition='])).toMatchObject({
      force: true,
      dryRun: true,
      model: 'qwen3:1.7b',
      siteDir: 'out',
      edition: '2026-11-10-evening',
    });
    expect(parseCliArgs([])).toMatchObject({ siteDir: '.work/site', stateFile: '.work/state/state.json', checkOnly: false });
    expect(parseCliArgs(['--check-only']).checkOnly).toBe(true);
    expect(() => parseCliArgs(['--bogus'])).toThrow(/Unknown/);
    expect(() => parseCliArgs(['--model'])).toThrow(/Missing/);
  });
});

describe('summaries', () => {
  const result: RunEditionResult = {
    status: 'published',
    deploy: true,
    editionKey: '2026-11-10-evening',
    siteDir: '.work/site',
    nextStateFile: '.work/state/next-state.json',
    summary: {
      status: 'published',
      editionKey: '2026-11-10-evening',
      dryRun: false,
      startedAt: 'a',
      finishedAt: 'b',
      storyCount: 3,
      audio: { available: true, bytes: 100, durationSec: 300 },
      metrics: { githubRequests: 120, tokensPerSecond: 9.5 },
      stageSeconds: { collect: 4, total: 400 },
      infra: { modelPullSeconds: 30, modelCacheHit: true },
    },
  };

  it('renders the step summary and outputs', () => {
    const md = renderSummaryMarkdown(result);
    expect(md).toContain('| GitHub API requests | 120 |');
    expect(md).toContain('| modelPullSeconds | 30 |');
    expect(renderGithubOutputs(result)).toContain('deploy=true\nedition=2026-11-10-evening');
  });

  it('reads workflow timings from the environment', () => {
    expect(infraFromEnv({ MODEL_PULL_SECONDS: '12', OLLAMA_INSTALL_SECONDS: 'x', MODEL_CACHE_HIT: 'true' })).toEqual({ modelPullSeconds: 12, modelCacheHit: true });
  });
});
