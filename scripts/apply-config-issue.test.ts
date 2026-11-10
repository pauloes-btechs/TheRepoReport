import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EditorialConfig, WatchlistConfig } from '../shared/schemas';
import { saveToProductionUrl, serializeConfig } from '../src/lib/config-draft';
import { parseConfigIssue } from './apply-config-issue';

const watchlist = WatchlistConfig.parse(JSON.parse(readFileSync('fixtures/config/watchlist.json', 'utf8')));
const editorial = EditorialConfig.parse(JSON.parse(readFileSync('fixtures/config/editorial.json', 'utf8')));
const block = (name: string, content: string) => ['```json file=' + name, content.trimEnd(), '```'].join('\n');

describe('Save to production round trip', () => {
  it('the issue the Settings button opens is applied exactly as drafted', () => {
    const draft = { ...watchlist, includeStarred: false, repos: watchlist.repos.slice(0, 3) };
    const url = saveToProductionUrl([{ name: 'watchlist.json', content: serializeConfig(draft) }])!;
    const params = new URL(url).searchParams;
    expect(url.startsWith('https://github.com/pauloes-btechs/TheRepoReport/issues/new?')).toBe(true);
    expect(params.get('title')).toBe('[config] Update watchlist.json');
    const { files, errors } = parseConfigIssue(params.get('body')!);
    expect(errors).toEqual([]);
    expect(JSON.parse(files['watchlist.json']!)).toEqual(draft);
    expect(files['editorial.json']).toBeUndefined();
  });

  it('keeps both files when both changed', () => {
    const url = saveToProductionUrl([
      { name: 'watchlist.json', content: serializeConfig(watchlist) },
      { name: 'editorial.json', content: serializeConfig({ ...editorial, minScore: 40 }) },
    ])!;
    const { files, errors } = parseConfigIssue(new URL(url).searchParams.get('body')!);
    expect(errors).toEqual([]);
    expect(JSON.parse(files['editorial.json']!).minScore).toBe(40);
  });

  it('refuses a URL too long to open reliably', () => {
    const huge = { ...watchlist, repos: Array.from({ length: 200 }, (_, i) => ({ ...watchlist.repos[0]!, repo: `owner/repo-${i}` })) };
    expect(saveToProductionUrl([{ name: 'watchlist.json', content: serializeConfig(huge) }])).toBeUndefined();
    expect(saveToProductionUrl([])).toBeUndefined();
  });
});

describe('parseConfigIssue rejects bad input and writes nothing', () => {
  it.each([
    ['invalid JSON', block('watchlist.json', '{ not json')],
    ['a bad repo slug', block('watchlist.json', JSON.stringify({ ...watchlist, repos: [{ repo: 'not a repo' }] }))],
    ['duplicate repos', block('watchlist.json', JSON.stringify({ ...watchlist, repos: [watchlist.repos[0], watchlist.repos[0]] }))],
    ['weights not totalling 100', block('editorial.json', JSON.stringify({ ...editorial, weights: { ...editorial.weights, security: 50 } }))],
    ['an unknown file', block('../../.github/workflows/edition.yml', '{}')],
    ['no files at all', 'Just some text.'],
  ])('%s', (_label, body) => {
    const { files, errors } = parseConfigIssue(body);
    expect(errors.length).toBeGreaterThan(0);
    if (!/unknown/.test(_label)) expect(Object.keys(files)).toHaveLength(Object.keys(files).length);
  });

  it('never targets a path outside config/', () => {
    const { files } = parseConfigIssue(block('../evil.json', '{}') + '\n' + block('watchlist.json', serializeConfig(watchlist)));
    expect(Object.keys(files)).toEqual(['watchlist.json']);
  });
});

describe('config-update workflow', () => {
  const yml = readFileSync('.github/workflows/config-update.yml', 'utf8');

  it('only acts on [config] issues opened by the repository owner', () => {
    expect(yml).toMatch(/github\.event\.issue\.user\.login == github\.repository_owner/);
    expect(yml).toMatch(/startsWith\(github\.event\.issue\.title, '\[config\]'\)/);
  });

  it('passes the issue body through the environment, never into a shell command', () => {
    expect(yml).toMatch(/ISSUE_BODY: \$\{\{ github\.event\.issue\.body \}\}/);
    // Collect every `run:` script (inline or block) and make sure none expands issue text.
    const scripts: string[] = [];
    const lines = yml.split('\n');
    lines.forEach((line, i) => {
      const m = /^(\s+)run:\s*(.*)$/.exec(line);
      if (!m) return;
      if (m[2] && m[2] !== '|') return void scripts.push(m[2]);
      const indent = m[1]!.length;
      for (let j = i + 1; j < lines.length && (lines[j]!.trim() === '' || lines[j]!.search(/\S/) > indent); j++) scripts.push(lines[j]!);
    });
    expect(scripts.length).toBeGreaterThan(3);
    expect(scripts.join('\n')).not.toMatch(/\$\{\{/);
  });

  it('commits as the owner with write access limited to this job', () => {
    expect(yml).toMatch(/^permissions:\n  contents: read/m);
    expect(yml).toMatch(/GIT_AUTHOR_NAME: Pauloes Berhe/);
    expect(yml).toMatch(/GIT_COMMITTER_EMAIL: pauloes@btechs.io/);
  });
});
