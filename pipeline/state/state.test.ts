import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PipelineState, StoryState } from '../../shared/schemas';
import {
  StateFileError,
  computeNextState,
  loadState,
  markCovered,
  mergeRepoState,
  previousStatusIfAdvanced,
  pruneStories,
  saveState,
  upsertStories,
} from './index';

const now = new Date('2026-11-10T18:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const entry = (updatedAt: string, extra: Partial<StoryState> = {}): StoryState => ({
  title: 't',
  repo: 'a/b',
  status: 'merged',
  firstSeen: updatedAt,
  eventIds: [],
  updatedAt,
  ...extra,
});

describe('pruneStories', () => {
  it('drops stories not updated in 14 days and keeps the rest', () => {
    const pruned = pruneStories(
      { fresh: entry(daysAgo(1)), edge: entry(daysAgo(13.9)), stale: entry(daysAgo(14.1)), ancient: entry(daysAgo(40)) },
      now,
    );
    expect(Object.keys(pruned).sort()).toEqual(['edge', 'fresh']);
  });

  it('drops entries with unparseable timestamps', () => {
    expect(pruneStories({ bad: entry('not a date') }, now)).toEqual({});
  });
});

describe('coverage marking', () => {
  it('records edition, time and status for covered stories only', () => {
    const marked = markCovered({ a: entry(daysAgo(1)), b: entry(daysAgo(1)) }, [{ id: 'a', status: 'released' }, { id: 'missing', status: 'merged' }], '2026-11-10-afternoon', now);
    expect(marked.a).toMatchObject({ lastCoveredEdition: '2026-11-10-afternoon', lastCoveredStatus: 'released', lastCoveredAt: now.toISOString() });
    expect(marked.b?.lastCoveredEdition).toBeUndefined();
    expect(marked.missing).toBeUndefined();
  });

  it('upsert keeps coverage fields and unions event ids', () => {
    const registry = { s1: entry(daysAgo(3), { lastCoveredEdition: 'k', lastCoveredStatus: 'merged', eventIds: ['e1'] }) };
    const next = upsertStories(registry, [
      {
        id: 's1',
        repo: 'a/b',
        title: 'new title',
        status: 'released',
        statusEvidenceUrl: 'https://github.com/a/b/releases/tag/v1',
        categories: [],
        firstSeen: daysAgo(1),
        updatedAt: daysAgo(0),
        events: [{ id: 'e2', kind: 'release', repo: 'a/b', title: 'v1', body: '', url: 'https://github.com/a/b/releases/tag/v1', labels: [], refs: [], state: 'published', createdAt: daysAgo(0), updatedAt: daysAgo(0) }],
      },
    ]);
    expect(next.s1).toMatchObject({ title: 'new title', status: 'released', lastCoveredEdition: 'k', lastCoveredStatus: 'merged', firstSeen: daysAgo(3) });
    expect(next.s1?.eventIds).toEqual(['e1', 'e2']);
  });

  it('reports the previous status only when it advanced', () => {
    expect(previousStatusIfAdvanced(entry(daysAgo(1), { lastCoveredStatus: 'merged' }), 'released')).toBe('merged');
    expect(previousStatusIfAdvanced(entry(daysAgo(1), { lastCoveredStatus: 'merged' }), 'merged')).toBeUndefined();
    expect(previousStatusIfAdvanced(entry(daysAgo(1)), 'released')).toBeUndefined();
    expect(previousStatusIfAdvanced(undefined, 'released')).toBeUndefined();
  });
});

describe('mergeRepoState', () => {
  it('advances cursors for successful repos and keeps old cursors for failed ones', () => {
    const prev: PipelineState['repos'] = { 'a/ok': { since: 'old', etags: {} }, 'a/fail': { since: 'old', etags: { x: '1' } } };
    const next: PipelineState['repos'] = { 'a/ok': { since: 'new', etags: {} }, 'a/fail': { since: 'new', etags: {} }, 'a/newfail': { since: 'new', etags: {} } };
    const merged = mergeRepoState(prev, next, [{ repo: 'a/fail' }, { repo: 'a/newfail' }]);
    expect(merged['a/ok']?.since).toBe('new');
    expect(merged['a/fail']).toEqual({ since: 'old', etags: { x: '1' } });
    expect(merged['a/newfail']).toBeUndefined();
  });
});

describe('load/save', () => {
  it('round-trips, treats a missing file as empty state, and rejects invalid files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-'));
    expect(await loadState(join(dir, 'missing.json'))).toEqual({ schemaVersion: 1, repos: {}, stories: {} });
    const state: PipelineState = { schemaVersion: 1, lastEditionKey: 'k', repos: { 'a/b': { since: 'x', etags: {} } }, stories: { s: entry(daysAgo(1)) } };
    await saveState(join(dir, 'nested', 'state.json'), state);
    expect(await loadState(join(dir, 'nested', 'state.json'))).toEqual(state);
    writeFileSync(join(dir, 'bad.json'), '{"schemaVersion": 2}');
    await expect(loadState(join(dir, 'bad.json'))).rejects.toBeInstanceOf(StateFileError);
    writeFileSync(join(dir, 'garbage.json'), '{nope');
    await expect(loadState(join(dir, 'garbage.json'))).rejects.toBeInstanceOf(StateFileError);
  });
});

describe('computeNextState', () => {
  it('records the edition, prunes, marks covered and merges cursors', () => {
    const previous: PipelineState = {
      schemaVersion: 1,
      repos: { 'a/b': { since: 'old', etags: {} } },
      stories: { stale: entry(daysAgo(20)), kept: entry(daysAgo(2)) },
    };
    const next = computeNextState({
      previous,
      collect: { nextRepoState: { 'a/b': { since: 'new', etags: {} } }, failedRepos: [] },
      stories: [],
      covered: [{ id: 'kept', status: 'merged' }],
      editionKey: '2026-11-10-afternoon',
      now,
    });
    expect(next.lastEditionKey).toBe('2026-11-10-afternoon');
    expect(next.lastSuccessfulRunAt).toBe(now.toISOString());
    expect(next.repos['a/b']?.since).toBe('new');
    expect(Object.keys(next.stories)).toEqual(['kept']);
    expect(next.stories.kept?.lastCoveredEdition).toBe('2026-11-10-afternoon');
  });
});
