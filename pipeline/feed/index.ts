/**
 * Podcast feed: RSS 2.0 with iTunes and Podcasting 2.0 namespaces, one item per
 * archived edition that has downloadable audio.
 */
import type { BuildFeed, FeedOptions } from '../../shared/contracts';
import { EDITION_TITLES } from '../../shared/edition';
import type { EditionReport, ManifestEdition } from '../../shared/schemas';
import { formatEditionDate, hhmmss, rfc822 } from './dates';

export const FEED_TITLE = 'TheRepoReport';
export const FEED_AUTHOR = 'Pauloes Berhe';
export const FEED_FILE = 'feed.xml';
export const COVER_IMAGE = 'podcast-cover.png';
const MAX_SUMMARY_HEADLINES = 5;

// ───────────────────────── XML text ─────────────────────────

/** Removes characters XML 1.0 forbids (C0 controls except tab/LF/CR, DEL, lone surrogates, U+FFFE/U+FFFF). */
export function stripControl(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F￾￿]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  );
}

/** Escapes text for element content and attribute values. */
export function xmlEscape(value: string): string {
  return stripControl(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Collapses whitespace so one-line fields (titles) stay on one line. */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

const el = (name: string, text: string) => `<${name}>${xmlEscape(oneLine(text))}</${name}>`;

// ───────────────────────── Items ─────────────────────────

export function feedGuid(key: string): string {
  return `therepreport-${key}`;
}

function headlineOf(edition: ManifestEdition, report: EditionReport | undefined): string {
  const fromReport = report?.stories[0]?.explanation.headline;
  const headline = edition.topHeadline ?? fromReport;
  if (headline && headline.trim()) return headline;
  return edition.quiet || report?.quiet ? 'A quiet period on the watchlist' : 'The latest from the watchlist';
}

export function itemTitle(edition: ManifestEdition, report: EditionReport | undefined): string {
  return `${EDITION_TITLES[edition.edition]} — ${formatEditionDate(edition.date)}: ${headlineOf(edition, report)}`;
}

function itemDescription(edition: ManifestEdition, report: EditionReport | undefined): string {
  const headlines = (report?.stories ?? [])
    .map((s) => oneLine(s.explanation.headline))
    .filter(Boolean)
    .slice(0, MAX_SUMMARY_HEADLINES);
  if (headlines.length > 0) {
    const more = (report?.stories.length ?? 0) - headlines.length;
    return `In this edition: ${headlines.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
  }
  if (edition.quiet || report?.quiet) return 'A quiet period: nothing on the watchlist cleared the reporting threshold.';
  return edition.topHeadline ? `In this edition: ${oneLine(edition.topHeadline)}.` : 'The latest from the watchlist.';
}

interface Enclosure {
  url: string;
  bytes: number;
  durationSec?: number;
}

/** The edition's audio, or undefined when it has none worth listing. */
function enclosureFor(edition: ManifestEdition, report: EditionReport | undefined, siteUrl: string): Enclosure | undefined {
  if (!edition.audioPath) return undefined;
  if (report && !report.audio.available) return undefined;
  const bytes = edition.audioBytes ?? report?.audio.bytes;
  if (bytes === undefined || bytes <= 0) return undefined;
  const durationSec = edition.durationSec ?? report?.audio.durationSec;
  return { url: new URL(edition.audioPath, siteUrl).href, bytes, durationSec };
}

function renderItem(edition: ManifestEdition, report: EditionReport | undefined, siteUrl: string): string | undefined {
  const enclosure = enclosureFor(edition, report, siteUrl);
  if (!enclosure) return undefined;
  const lines = [
    '    <item>',
    `      ${el('title', itemTitle(edition, report))}`,
    `      ${el('link', `${siteUrl}#/edition/${edition.key}`)}`,
    `      <guid isPermaLink="false">${xmlEscape(feedGuid(edition.key))}</guid>`,
  ];
  const pubDate = rfc822(edition.publishedAt);
  if (pubDate) lines.push(`      ${el('pubDate', pubDate)}`);
  lines.push(
    `      ${el('description', itemDescription(edition, report))}`,
    `      <enclosure url="${xmlEscape(enclosure.url)}" length="${Math.round(enclosure.bytes)}" type="audio/mpeg"/>`,
  );
  if (enclosure.durationSec !== undefined) lines.push(`      ${el('itunes:duration', hhmmss(enclosure.durationSec))}`);
  lines.push(`      ${el('itunes:episodeType', 'full')}`, `      ${el('itunes:explicit', 'false')}`, '    </item>');
  return lines.join('\n');
}

// ───────────────────────── Channel ─────────────────────────

export const buildFeed: BuildFeed = (options: FeedOptions) => {
  const { manifest, reports, siteUrl } = options;
  if (!/^https?:\/\/.+\/$/.test(siteUrl)) throw new Error(`buildFeed: siteUrl must be absolute and end with "/": ${siteUrl}`);

  const days = manifest.retentionDays;
  const description =
    'An automated GitHub newsroom: releases, security advisories, and notable changes from a personal watchlist of ' +
    'public repositories, ranked by a transparent impact score and explained in plain English. Three editions a day. ' +
    `Episodes expire after ${days} ${days === 1 ? 'day' : 'days'} and then disappear from this feed.`;

  const items = manifest.editions
    .map((edition) => renderItem(edition, reports[edition.key], siteUrl))
    .filter((item): item is string => item !== undefined);

  const lastBuild = rfc822(manifest.generatedAt);
  const cover = `${siteUrl}${COVER_IMAGE}`;
  const channel = [
    `    ${el('title', FEED_TITLE)}`,
    `    ${el('link', siteUrl)}`,
    `    <atom:link href="${xmlEscape(`${siteUrl}${FEED_FILE}`)}" rel="self" type="application/rss+xml"/>`,
    `    ${el('description', description)}`,
    `    ${el('language', 'en-us')}`,
    ...(lastBuild ? [`    ${el('lastBuildDate', lastBuild)}`] : []),
    `    ${el('generator', 'TheRepoReport pipeline')}`,
    '    <image>',
    `      ${el('url', cover)}`,
    `      ${el('title', FEED_TITLE)}`,
    `      ${el('link', siteUrl)}`,
    '    </image>',
    `    ${el('itunes:author', FEED_AUTHOR)}`,
    `    ${el('itunes:summary', description)}`,
    `    ${el('itunes:type', 'episodic')}`,
    `    ${el('itunes:explicit', 'false')}`,
    `    <itunes:image href="${xmlEscape(cover)}"/>`,
    '    <itunes:category text="Technology"/>',
    `    ${el('podcast:medium', 'podcast')}`,
    ...items,
  ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" ' +
      'xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    ...channel,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
};
