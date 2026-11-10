import { describe, expect, it } from 'vitest';
import type { ManifestEdition } from '../../shared/schemas';
import { fixtureReport, MORNING } from '../test/helpers';
import { computeSlots, groupByDate, isAlert } from './editions';

function entry(key: string, publishedAt = '2026-11-10T12:30:00Z'): ManifestEdition {
  const [date, edition] = [key.slice(0, 10), key.slice(11) as ManifestEdition['edition']];
  return { key, date, edition, publishedAt, storyCount: 1, quiet: false, summarization: 'llm', reportPath: `data/editions/${key}/report.json` };
}

describe('computeSlots', () => {
  // 2026-11-10 is in EST (UTC-5).
  const at = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00-05:00`);

  it('marks published, due, upcoming slots in the morning', () => {
    const { date, slots } = computeSlots([entry('2026-11-10-morning')], at('07:40'));
    expect(date).toBe('2026-11-10');
    expect(slots.map((s) => s.state)).toEqual(['published', 'upcoming', 'upcoming']);
    expect(slots[0]!.entry?.key).toBe('2026-11-10-morning');
  });

  it('treats a slot as due during the grace period and missed after it', () => {
    expect(computeSlots([], at('07:30')).slots[0]).toMatchObject({ state: 'upcoming', due: true });
    expect(computeSlots([], at('08:30')).slots[0]).toMatchObject({ state: 'missed', due: false });
  });

  it('computes the evening correctly', () => {
    const { slots } = computeSlots([entry('2026-11-10-morning'), entry('2026-11-10-evening')], at('21:00'));
    expect(slots.map((s) => s.state)).toEqual(['published', 'missed', 'published']);
  });

  it('shows all slots upcoming before the first edition and ignores yesterday', () => {
    const { date, slots } = computeSlots([entry('2026-11-09-evening')], at('06:00'));
    expect(date).toBe('2026-11-10');
    expect(slots.every((s) => s.state === 'upcoming' && !s.due)).toBe(true);
  });

  it('uses the New York date across DST (summer, UTC-4)', () => {
    const { date, slots } = computeSlots([entry('2026-07-01-afternoon')], new Date('2026-07-01T17:20:00Z'));
    expect(date).toBe('2026-07-01');
    expect(slots[1]!.state).toBe('published');
    expect(slots[0]!.state).toBe('missed');
  });
});

describe('groupByDate', () => {
  it('groups newest date first and orders editions newest first within a day', () => {
    const days = groupByDate([
      entry('2026-11-09-morning'),
      entry('2026-11-10-morning'),
      entry('2026-11-09-evening'),
      entry('2026-11-09-afternoon'),
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-11-10', '2026-11-09']);
    expect(days[1]!.editions.map((e) => e.edition)).toEqual(['evening', 'afternoon', 'morning']);
  });

  it('returns nothing for an empty archive', () => {
    expect(groupByDate([])).toEqual([]);
  });
});

describe('isAlert', () => {
  it('flags security stories and high-band releases only', () => {
    const report = fixtureReport(MORNING);
    const byId = Object.fromEntries(report.stories.map((s) => [s.id, isAlert(s)]));
    expect(byId['ollama-ollama-model-import-path']).toBe(true); // security points
    expect(byId['vitejs-vite-v7-node-floor']).toBe(true); // released, band high
    expect(byId['lnd-taproot-assets-rpc']).toBe(false); // merged
    expect(byId['claude-code-hooks-timeout']).toBe(false); // released but notable
  });
});
