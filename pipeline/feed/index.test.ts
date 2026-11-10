import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SITE_URL } from '../../shared/contracts';
import {
  EditionReport,
  EditorialConfig,
  Manifest,
  WatchlistConfig,
  type ManifestEdition,
} from '../../shared/schemas';
import { formatEditionDate, hhmmss, rfc822 } from './dates';
import { buildFeed, feedGuid, stripControl, xmlEscape } from './index';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const config = {
  watchlist: WatchlistConfig.parse(JSON.parse(readFileSync(resolve(ROOT, 'config/watchlist.json'), 'utf8'))),
  editorial: EditorialConfig.parse(JSON.parse(readFileSync(resolve(ROOT, 'config/editorial.json'), 'utf8'))),
};

// ───────────────────────── Minimal XML well-formedness check ─────────────────────────

interface XmlCheck {
  ok: boolean;
  errors: string[];
}

/**
 * Not a full parser: verifies one prolog, balanced and properly nested tags,
 * quoted attributes, no raw "<" or "&" in text, and only known entities.
 */
function checkXml(xml: string): XmlCheck {
  const errors: string[] = [];
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) errors.push('missing XML declaration');
  const body = xml.replace(/^<\?xml[^?]*\?>/, '');
  if (/<\?|<!--|<!\[CDATA\[|<!DOCTYPE/.test(body)) errors.push('unexpected markup declaration');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)) errors.push('control character');
  const badAmp = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(body);
  if (badAmp) errors.push(`bare ampersand at ${badAmp.index}`);

  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*="[^"<]*")*)\s*(\/?)>/g;
  const stack: string[] = [];
  let last = 0;
  let roots = 0;
  for (const m of body.matchAll(tag)) {
    const text = body.slice(last, m.index);
    if (text.includes('<') || text.includes('>')) errors.push(`stray markup in text near ${m.index}: ${text.slice(0, 40)}`);
    if (stack.length === 0 && text.trim()) errors.push('text outside root');
    last = m.index + m[0].length;
    const [, closing, name, , selfClosing] = m;
    if (closing) {
      const open = stack.pop();
      if (open !== name) errors.push(`</${name}> closes <${open ?? 'nothing'}>`);
    } else if (!selfClosing) {
      if (stack.length === 0) roots++;
      stack.push(name!);
    } else if (stack.length === 0) roots++;
  }
  const tail = body.slice(last);
  if (tail.includes('<') || tail.trim()) errors.push('trailing content');
  if (stack.length) errors.push(`unclosed: ${stack.join(',')}`);
  if (roots !== 1) errors.push(`expected one root element, found ${roots}`);
  return { ok: errors.length === 0, errors };
}

/** Text of every <name>…</name> (non-nested). */
const all = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, 'g'))].map((m) => m[1]!);
const items = (xml: string) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);

// ───────────────────────── Fixtures ─────────────────────────

function report(key: string, headlines: string[], audio: Partial<EditionReport['audio']> = {}): EditionReport {
  const [date, edition] = [key.slice(0, 10), key.slice(11)];
  return EditionReport.parse({
    schemaVersion: 1,
    key,
    date,
    edition,
    generatedAt: `${date}T12:20:00Z`,
    windowStart: `${date}T00:00:00Z`,
    windowEnd: `${date}T12:15:00Z`,
    summarization: 'llm',
    quiet: headlines.length === 0,
    stories: headlines.map((headline, i) => ({
      id: `s${i}`,
      repo: 'example/repo',
      status: 'released',
      statusEvidenceUrl: 'https://github.com/example/repo/releases/tag/v1',
      categories: [],
      score: { total: 80 - i, band: 'major', dimensions: [], confidence: 'high', confidenceReason: 'two sources' },
      explanation: {
        headline,
        whatHappened: 'Something happened in the repository today.',
        previously: 'Before this.',
        whatChanged: 'This changed.',
        whyItMatters: 'It matters because users are affected.',
        nextConfirmed: '',
        nextSpeculative: '',
        glossary: [],
        analogy: '',
        intermediate: '',
        technical: '',
        source: 'llm',
      },
      links: [],
      updatedAt: `${date}T12:00:00Z`,
    })),
    transcript: [],
    audio: { available: true, file: 'audio.mp3', bytes: 123_456, durationSec: 421.4, chapters: [], ...audio },
  });
}

function entry(key: string, extra: Partial<ManifestEdition> = {}): ManifestEdition {
  return {
    key,
    date: key.slice(0, 10),
    edition: key.slice(11) as ManifestEdition['edition'],
    publishedAt: `${key.slice(0, 10)}T12:25:00Z`,
    storyCount: 2,
    quiet: false,
    summarization: 'llm',
    reportPath: `data/editions/${key}/report.json`,
    audioPath: `data/editions/${key}/audio.mp3`,
    audioBytes: 123_456,
    durationSec: 421.4,
    ...extra,
  };
}

function manifest(editions: ManifestEdition[]) {
  return Manifest.parse({
    schemaVersion: 1,
    generatedAt: '2026-11-10T18:30:00Z',
    lastSuccessfulScan: '2026-11-10T18:15:00Z',
    retentionDays: 7,
    editions,
    repos: [],
    config,
  });
}

const A = '2026-11-10-afternoon';
const B = '2026-11-10-morning';
const C = '2026-11-09-evening';
const D = '2026-11-09-afternoon';

const reports: Record<string, EditionReport> = {
  [A]: report(A, ['Tom & Jerry <script>alert("x")</script> ships v2 > v1', 'Second story']),
  [B]: report(B, ['Morning lead'], { bytes: 999 }),
  [C]: report(C, ['No audio here'], { available: false, file: undefined, bytes: undefined, unavailableReason: 'piper failed' }),
  [D]: report(D, [], {}),
};
const editions = [
  entry(A, { topHeadline: reports[A]!.stories[0]!.explanation.headline, audioBytes: 2_048_000, durationSec: 3725 }),
  entry(B, { topHeadline: 'Morning lead' }),
  entry(C, { topHeadline: 'No audio here', audioPath: undefined, audioBytes: undefined, durationSec: undefined }),
  entry(D, { quiet: true, storyCount: 0 }),
];

// ───────────────────────── Tests ─────────────────────────

describe('helpers', () => {
  it('escapes XML specials and strips control characters', () => {
    expect(xmlEscape(`a & b < c > d "e" 'f'`)).toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
    expect(stripControl('a\u0000b\u0007c\u001Fd\te\nf￿\uD800')).toBe('abcd\te\nf');
  });
  it('formats dates and durations', () => {
    expect(formatEditionDate('2026-11-09')).toBe('Nov 9, 2026');
    expect(rfc822('2026-11-10T12:25:00Z')).toBe('Tue, 10 Nov 2026 12:25:00 GMT');
    expect(hhmmss(3725.4)).toBe('01:02:05');
    expect(hhmmss(59.6)).toBe('00:01:00');
  });
});

describe('buildFeed', () => {
  const xml = buildFeed({ manifest: manifest(editions), reports, siteUrl: SITE_URL });

  it('is well-formed XML', () => {
    expect(checkXml(xml)).toEqual({ ok: true, errors: [] });
    // The checker itself catches broken input.
    expect(checkXml(xml.replace('</channel>', '')).ok).toBe(false);
    expect(checkXml(xml.replace('&amp;', '&')).ok).toBe(false);
  });

  it('has the required channel elements', () => {
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
    expect(xml).toContain('xmlns:podcast="https://podcastindex.org/namespace/1.0"');
    const channel = xml.slice(0, xml.indexOf('<item>'));
    expect(all(channel, 'title')[0]).toBe('TheRepoReport');
    expect(all(channel, 'link')[0]).toBe(SITE_URL);
    expect(all(channel, 'language')).toEqual(['en-us']);
    expect(all(channel, 'itunes:author')).toEqual(['Pauloes Berhe']);
    expect(all(channel, 'itunes:explicit')).toEqual(['false']);
    expect(all(channel, 'description')[0]).toMatch(/Episodes expire after 7 days/);
    expect(channel).toContain('<itunes:category text="Technology"/>');
    expect(channel).toContain(`<itunes:image href="${SITE_URL}podcast-cover.png"/>`);
    expect(channel).toContain(`<atom:link href="${SITE_URL}feed.xml" rel="self" type="application/rss+xml"/>`);
  });

  it('lists only editions with audio, newest first, with stable GUIDs', () => {
    const its = items(xml);
    expect(its).toHaveLength(3);
    expect(its.map((i) => all(i, 'guid')[0])).toEqual([feedGuid(A), feedGuid(B), feedGuid(D)]);
    expect(feedGuid(A)).toBe('thereporeport-2026-11-10-afternoon');
    expect(xml).not.toContain('No audio here');
    expect(xml).toContain('<guid isPermaLink="false">thereporeport-2026-11-10-afternoon</guid>');
    // Same input, same output.
    expect(buildFeed({ manifest: manifest(editions), reports, siteUrl: SITE_URL })).toBe(xml);
  });

  it('omits an edition whose report says audio is unavailable even if the manifest has a path', () => {
    const withPath = [entry(C, { topHeadline: 'No audio here' })];
    const out = buildFeed({ manifest: manifest(withPath), reports, siteUrl: SITE_URL });
    expect(items(out)).toHaveLength(0);
    expect(checkXml(out).ok).toBe(true);
  });

  it('writes enclosure, duration, dates, links and titles', () => {
    const [first, second, quiet] = items(xml);
    expect(first).toContain(
      `<enclosure url="${SITE_URL}data/editions/${A}/audio.mp3" length="2048000" type="audio/mpeg"/>`,
    );
    expect(all(first!, 'itunes:duration')).toEqual(['01:02:05']);
    expect(all(first!, 'pubDate')).toEqual(['Tue, 10 Nov 2026 12:25:00 GMT']);
    expect(all(first!, 'link')).toEqual([`${SITE_URL}#/edition/${A}`]);
    // Manifest byte count wins; report bytes are only a fallback.
    expect(second).toContain('length="123456"');
    expect(all(second!, 'title')).toEqual(['Morning Edition — Nov 10, 2026: Morning lead']);
    expect(all(quiet!, 'title')).toEqual(['Afternoon Edition — Nov 9, 2026: A quiet period on the watchlist']);
    expect(all(quiet!, 'description')[0]).toMatch(/quiet period/i);
  });

  it('escapes &, <, > and quotes in headlines', () => {
    const first = items(xml)[0]!;
    const title = all(first, 'title')[0]!;
    expect(title).toBe(
      'Afternoon Edition — Nov 10, 2026: Tom &amp; Jerry &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; ships v2 &gt; v1',
    );
    expect(all(first, 'description')[0]).toBe(
      'In this edition: Tom &amp; Jerry &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; ships v2 &gt; v1; Second story.',
    );
    expect(xml).not.toContain('<script>');
  });

  it('strips control characters from headlines', () => {
    const r = report(B, ['Bell\u0007 and null\u0000 chars']);
    const out = buildFeed({
      manifest: manifest([entry(B, { topHeadline: 'Bell\u0007 and null\u0000 chars' })]),
      reports: { [B]: r },
      siteUrl: SITE_URL,
    });
    expect(checkXml(out).ok).toBe(true);
    expect(out).toContain('Bell and null chars');
  });

  it('produces an empty but valid channel when nothing has audio', () => {
    const out = buildFeed({ manifest: manifest([]), reports: {}, siteUrl: SITE_URL });
    expect(checkXml(out).ok).toBe(true);
    expect(items(out)).toHaveLength(0);
  });

  it('rejects a site URL without a trailing slash', () => {
    expect(() => buildFeed({ manifest: manifest([]), reports: {}, siteUrl: 'https://example.com/x' })).toThrow();
  });
});
