import { describe, expect, it } from 'vitest';
import { EDITIONS, type ExplainedStory, type ScoredStory } from '../../shared/schemas';
import { fallbackExplanation } from '../llm/fallback';
import { allFixtures, editorialConfig, loadFixture } from '../llm/test-helpers';
import { buildScript, estimateMinutes, pronounce } from './index';

const editorial = editorialConfig();

function explained(name: string): ExplainedStory {
  const f = loadFixture(name);
  const explanation =
    f.cannedOutput && f.expectValid
      ? { ...(f.cannedOutput as ExplainedStory['explanation']), source: 'llm' as const, validationNotes: [] }
      : fallbackExplanation(f.story, []);
  return { ...f.story, explanation };
}

const stories = ['security-advisory-release', 'pr-issue-release', 'merged-unreleased-feature', 'merged-overclaim'].map(explained);
const watching: ScoredStory[] = [loadFixture('open-proposal').story];

describe('buildScript: structure', () => {
  const segments = buildScript({ edition: 'morning', date: '2026-11-10', stories, watching, editorial });

  it('follows broadcast order', () => {
    expect(segments.map((s) => s.kind)).toEqual(['intro', 'headlines', 'lead', 'story', 'story', 'story', 'why', 'watching', 'closing']);
    expect(new Set(segments.map((s) => s.id)).size).toBe(segments.length);
  });

  it('sets storyId on lead and story segments in rank order', () => {
    const withIds = segments.filter((s) => s.kind === 'lead' || s.kind === 'story');
    expect(withIds.map((s) => s.storyId)).toEqual(stories.map((s) => s.id));
    expect(segments.filter((s) => s.kind !== 'lead' && s.kind !== 'story').every((s) => s.storyId === undefined)).toBe(true);
  });

  it('opens with the greeting, the show line and the edition framing', () => {
    const intro = segments[0]!.text;
    expect(intro).toMatch(/^Good morning\. You're listening to TheRepoReport, your personal AI-powered GitHub newsroom\./);
    expect(intro).toContain('Tuesday, November 10, 2026');
    expect(intro).toContain('overnight developments');
    expect(intro).toContain('4 stories');
  });

  it('reads 3–5 headlines', () => {
    const h = segments[1]!.text;
    for (const s of stories) expect(h).toContain(s.explanation.headline);
  });

  it('tells the lead story in full and others more briefly', () => {
    const lead = segments.find((s) => s.kind === 'lead')!.text;
    expect(lead).toMatch(/^Our lead story\./);
    expect(lead).toContain('Previously:');
    expect(lead).toContain('What changed:');
    expect(lead).toContain('Invoice: A payment request');
    expect(lead).toContain('Why it matters:');
    expect(lead).toContain("What's confirmed next:");
    expect(lead).toContain('this is not confirmed:');
    const second = segments.find((s) => s.kind === 'story')!.text;
    expect(second).not.toContain('Previously:');
    expect(second).toContain('Why it matters:');
  });

  it('states status plainly, keeping merged distinct from released', () => {
    const merged = segments.find((s) => s.storyId === stories[2]!.id)!.text;
    expect(merged).toContain('Status: Merged. It is in the main code but not yet in a release.');
  });

  it('connects stories to the listener topics using only story content', () => {
    const why = segments.find((s) => s.kind === 'why')!.text;
    expect(why).toMatch(/You follow bitcoin\./);
    expect(why).toMatch(/You follow AI\./);
    expect(why).not.toMatch(/defi|payments/i);
  });

  it('labels watch items as unmerged and unreleased', () => {
    const w = segments.find((s) => s.kind === 'watching')!.text;
    expect(w).toContain('none of them is in a release yet');
    expect(w).toContain('From bitcoin/bitcoin: p2p: add option to limit inbound connections per network.');
    expect(w).toContain('Status: Proposed. This is a proposal; it has not been merged or released.');
  });

  it('closes with takeaways and a sign-off', () => {
    const c = segments.at(-1)!.text;
    expect(c).toMatch(/^Three takeaways\./);
    expect(c).toContain("That's TheRepoReport for this morning edition.");
    expect(c).toContain("We'll be back this afternoon.");
  });

  it('runs the pronunciation pass into spokenText', () => {
    for (const s of segments) expect(s.spokenText).toBe(pronounce(s.text, editorial.lexicon));
    expect(segments[0]!.spokenText).toContain('The Repo Report');
    expect(segments.find((s) => s.kind === 'lead')!.spokenText).toContain('version 2 point 8 point 3');
  });
});

describe('buildScript: editions and quiet days', () => {
  it.each(EDITIONS)('%s edition greeting and framing', (edition) => {
    const [intro] = buildScript({ edition, date: '2026-11-10', stories, watching: [], editorial });
    const expected = { morning: ['Good morning', 'overnight developments'], afternoon: ['Good afternoon', "what's changed since this morning"], evening: ['Good evening', "the day's recap"] }[edition];
    expect(intro!.text.startsWith(expected[0]!)).toBe(true);
    expect(intro!.text).toContain(expected[1]!);
  });

  it('builds a short quiet-day script without invented headlines', () => {
    const segments = buildScript({ edition: 'evening', date: '2026-11-10', stories: [], watching, editorial });
    expect(segments.map((s) => s.kind)).toEqual(['intro', 'headlines', 'watching', 'closing']);
    expect(segments[1]!.text).toMatch(/No significant developments cleared our threshold in this window/);
    expect(segments.some((s) => s.kind === 'lead' || s.kind === 'story' || s.kind === 'why')).toBe(false);
    expect(segments.at(-1)!.text).toContain("We'll be back tomorrow morning.");
    const minutes = estimateMinutes(segments);
    expect(minutes).toBeGreaterThan(0.3);
    expect(minutes).toBeLessThan(1.5);
  });

  it('does not pad a light day', () => {
    const one = buildScript({ edition: 'afternoon', date: '2026-11-10', stories: [stories[0]!], watching: [], editorial });
    expect(estimateMinutes(one)).toBeLessThan(editorial.targetMinutes.min);
    expect(one.find((s) => s.kind === 'headlines')!.text).toMatch(/^Here's the top headline\./);
    expect(one.at(-1)!.text).toMatch(/^One takeaway\./);
  });
});

describe('buildScript: length control', () => {
  const many: ExplainedStory[] = Array.from({ length: 12 }, (_, i) => {
    const s = explained(i % 2 ? 'pr-issue-release' : 'security-advisory-release');
    return { ...s, id: `${s.id}-${i}` };
  });

  it('trims lower stories to the short form to stay under the maximum', () => {
    const untrimmedMax = { ...editorial, targetMinutes: { min: 5, max: 1000 } };
    const full = buildScript({ edition: 'morning', date: '2026-11-10', stories: many, watching, editorial: untrimmedMax });
    const tight = { ...editorial, targetMinutes: { min: 2, max: estimateMinutes(full) - 2 } };
    const trimmed = buildScript({ edition: 'morning', date: '2026-11-10', stories: many, watching, editorial: tight });
    expect(estimateMinutes(trimmed)).toBeLessThanOrEqual(tight.targetMinutes.max);
    // Lowest-ranked story is short; the lead keeps its full form.
    const last = trimmed.filter((s) => s.kind === 'story').at(-1)!.text;
    expect(last).not.toContain('Why it matters:');
    expect(trimmed.find((s) => s.kind === 'lead')!.text).toContain('Previously:');
    // Every story is still present.
    expect(trimmed.filter((s) => s.storyId).length).toBe(many.length);
  });

  it('shortens the lead only as a last resort', () => {
    const tiny = { ...editorial, targetMinutes: { min: 0.5, max: 1 } };
    const segs = buildScript({ edition: 'morning', date: '2026-11-10', stories: many, watching: [], editorial: tiny });
    expect(segs.find((s) => s.kind === 'lead')!.text).not.toContain('Previously:');
    expect(segs.filter((s) => s.storyId).length).toBe(many.length);
  });

  it('keeps the fixture edition inside the configured target', () => {
    const all = allFixtures().map((f) => explained(f.name));
    const segs = buildScript({ edition: 'morning', date: '2026-11-10', stories: all, watching: [], editorial });
    expect(estimateMinutes(segs)).toBeLessThanOrEqual(editorial.targetMinutes.max);
  });
});

describe('pronounce', () => {
  const lex = editorial.lexicon;
  it.each([
    ['ollama/ollama shipped', 'ollama shipped'],
    ['lightningnetwork/lnd merged it', 'L N D merged it'],
    ['OHF-Voice/piper1-gpl', 'piper1 gpl'],
    ['Upgrade to v0.9.1 now', 'Upgrade to version 0 point 9 point 1 now'],
    ['version 2.8.3 is out', 'version 2 point 8 point 3 is out'],
    ['lnd v0.19.3-beta', 'L N D version 0 point 19 point 3 beta'],
    ['v1.2.0-rc.1', 'version 1 point 2 point 0 release candidate 1'],
    ['Fixes CVE-2026-48211.', 'Fixes C V E 2026 dash four eight two one one.'],
    ['See GHSA-7x2q-9fvm-r4wp', 'See G H S A advisory'],
    ['Closes #123 and #45', 'Closes number 123 and number 45'],
    ['Read https://github.com/a/b/pull/1 for details', 'Read for details'],
    ['**Bold** and `code` and [link](https://x.y)', 'Bold and code and link'],
    ['The GitHub API and PRs', 'The git hub A P I and pull requests'],
    ['and/or', 'and or'],
    ['Merged on 2026-11-09', 'Merged on November 9, 2026'],
    ['30% faster', '30 percent faster'],
    ['TheRepoReport', 'The Repo Report'],
  ])('%s → %s', (input, expected) => {
    expect(pronounce(input, lex)).toBe(expected);
  });

  it('applies the lexicon on word boundaries only', () => {
    expect(pronounce('UI and GUIDE and UIs', { UI: 'U I' })).toBe('U I and GUIDE and U Is');
    expect(pronounce('npm install', lex)).toBe('N P M install');
    expect(pronounce('snpm', lex)).toBe('snpm');
  });

  it('does not cascade replacements', () => {
    expect(pronounce('PR', { PR: 'pull request', pull: 'PULL' })).toBe('pull request');
  });
});
