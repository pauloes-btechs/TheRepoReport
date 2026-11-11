/**
 * Evidence signals per scoring dimension. Points are expressed against the
 * default maxima (25/20/20/15/10/10) and scaled to the configured weights.
 * A signal is only emitted when a concrete event justifies it.
 */
import { isRoundup, substantivePulls } from '../stories/digest';
import type { DimensionKey, EditorialConfig, ManifestRepo, RawEvent, Story } from '../../shared/schemas';

export const BASE_MAX: Record<DimensionKey, number> = {
  security: 25,
  breaking: 20,
  capability: 20,
  reliability: 15,
  ecosystem: 10,
  relevance: 10,
};

export interface Signal {
  points: number;
  reason: string;
  evidenceUrl?: string;
}

export interface RubricContext {
  editorial: EditorialConfig;
  repo?: ManifestRepo;
}

const SEVERITY_POINTS = { critical: 25, high: 20, medium: 12, low: 6 } as const;
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'] as const;

const text = (e: RawEvent) => `${e.title}\n${e.body}`;
const stableReleases = (s: Story) => s.events.filter((e) => e.kind === 'release' && !e.prerelease);

/** Emits a signal for the first event matching `test`. */
function firstMatch(
  events: RawEvent[],
  test: (e: RawEvent) => boolean,
  points: number,
  reason: (e: RawEvent) => string,
): Signal[] {
  const hit = events.find(test);
  return hit ? [{ points, reason: reason(hit), evidenceUrl: hit.url }] : [];
}

const hasLabel = (pattern: RegExp) => (e: RawEvent) => e.labels.some((l) => pattern.test(l));

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(tag: string | undefined): Semver | undefined {
  const m = tag ? /^(?:[\w.-]*?[-/@])?v?(\d+)\.(\d+)(?:\.(\d+))?(?:$|[-+])/.exec(tag) : null;
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

function releaseOfType(s: Story, type: 'major' | 'minor' | 'patch'): RawEvent | undefined {
  return stableReleases(s).find((e) => {
    const v = parseSemver(e.tagName);
    if (!v) return false;
    if (type === 'major') return v.major >= 1 && v.minor === 0 && v.patch === 0;
    if (type === 'minor') return v.minor > 0 && v.patch === 0;
    return v.patch > 0;
  });
}

// ── Security ──

const CVE_OR_GHSA = /\b(CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})\b/i;
const SECURITY_TITLE = /vulnerab|exploit|\bRCE\b|remote code execution|security (fix|issue|patch)|privilege escalation|auth(entication)? bypass/i;

function security(s: Story): Signal[] {
  const signals: Signal[] = [];
  const advisories = s.events.filter((e) => e.kind === 'advisory' && e.severity);
  const worst = advisories.sort(
    (a, b) => SEVERITY_ORDER.indexOf(b.severity!) - SEVERITY_ORDER.indexOf(a.severity!),
  )[0];
  if (worst?.severity) {
    signals.push({
      points: SEVERITY_POINTS[worst.severity],
      reason: `Security advisory ${worst.ghsaId ?? ''} rated ${worst.severity} severity`.replace('  ', ' '),
      evidenceUrl: worst.url,
    });
  }
  const withCve = s.events.find((e) => e.kind === 'advisory' && e.cveId);
  if (withCve) {
    signals.push({ points: 8, reason: `Assigned ${withCve.cveId}`, evidenceUrl: withCve.url });
  } else {
    signals.push(
      ...firstMatch(s.events, (e) => CVE_OR_GHSA.test(text(e)), 5, (e) => `Mentions ${CVE_OR_GHSA.exec(text(e))?.[1]}`),
    );
  }
  signals.push(...firstMatch(s.events, hasLabel(/security|vulnerab/i), 8, () => 'Labeled as a security issue'));
  signals.push(...firstMatch(s.events, hasLabel(/^safety$|safety-critical/i), 5, () => 'Labeled as safety work'));
  signals.push(
    ...firstMatch(s.events, (e) => SECURITY_TITLE.test(e.title), 6, () => 'Title describes a vulnerability or exploit'),
  );
  return signals;
}

// ── Breaking change ──

const BREAKING_MARKER = /\bBREAKING\b|breaking change|^\s*\w+(\([^)]*\))?!:/im;
const DEPRECATION = /\bdeprecat(e|ed|es|ion|ing)\b/i;
const REMOVED_API =
  /\b(remov(e|ed|es)|renam(e|ed|es)|drop(s|ped)?)\b[^.\n]{0,40}\b(api|support|option|flag|parameter|endpoint|function|method|command|config(uration)?)\b/i;

function breaking(s: Story): Signal[] {
  const major = releaseOfType(s, 'major');
  return [
    ...(major ? [{ points: 12, reason: `Major version release ${major.tagName}`, evidenceUrl: major.url }] : []),
    ...firstMatch(s.events, (e) => BREAKING_MARKER.test(text(e)), 10, () => 'Explicit breaking-change marker'),
    ...firstMatch(s.events, hasLabel(/breaking/i), 10, () => 'Labeled as a breaking change'),
    ...firstMatch(
      s.events,
      (e) => hasLabel(/deprecat/i)(e) || DEPRECATION.test(text(e)),
      5,
      () => 'Deprecates existing behavior',
    ),
    ...firstMatch(s.events, (e) => REMOVED_API.test(text(e)), 4, () => 'Removes or renames an API or option'),
  ];
}

// ── New capability ──

const FEATURE_SECTION = /^\s*#{1,4}\s*(new features?|features?|what'?s new|added|enhancements?)\b|^\s*[-*]\s*feat(\(|!|:)/im;
const FEATURE_TITLE = /^\s*(feat(\(|!|:)|add(s|ed)?\b|introduc|implement|support(s)?\b|new\b|expose|enable|allow)/i;

/**
 * Many projects prefix titles with the component they touch
 * ("notifyrelay: Add an authenticated APNs relay"). Strip it so title rules see the verb.
 */
export function titleVerb(title: string): string {
  return title.replace(/^\s*(?!feat\b|fix\b)[\w./-]{2,30}(\([^)]*\))?!?:\s+/i, '');
}
const isFeatureTitle = (title: string) => FEATURE_TITLE.test(title) || FEATURE_TITLE.test(titleVerb(title));

// Many projects write release notes as "- Added …" / "* Fixed …" bullets rather
// than "## Features" headings (Claude Code, Ollama, Next.js all do).
const FEATURE_BULLET = /^\s*[-*•]\s+(?:\*\*)?(add(s|ed)?|new|introduc\w*|support(s|ed)? for|now (supports|lets|allows)|enable(s|d)?)\b/gim;
const FIX_BULLET = /^\s*[-*•]\s+(?:\*\*)?(fix(es|ed)?|resolv\w*|correct(s|ed)?|prevent(s|ed)?)\b/gim;

export function countBullets(body: string, pattern: RegExp): number {
  return body.match(pattern)?.length ?? 0;
}

function capability(s: Story): Signal[] {
  const major = releaseOfType(s, 'major');
  const minor = releaseOfType(s, 'minor');
  const versionBump = major ?? minor;
  const featureRelease = stableReleases(s).find(
    (e) => FEATURE_SECTION.test(e.body) || countBullets(e.body, FEATURE_BULLET) > 0,
  );
  const featureCount = featureRelease ? countBullets(featureRelease.body, FEATURE_BULLET) : 0;
  return [
    ...(featureRelease
      ? [
          {
            points: 10,
            reason: `Release ${featureRelease.tagName ?? featureRelease.title} lists new features`,
            evidenceUrl: featureRelease.url,
          },
        ]
      : []),
    ...(featureCount >= 3
      ? [{ points: 4, reason: `Release notes list ${featureCount} additions`, evidenceUrl: featureRelease!.url }]
      : []),
    ...firstMatch(s.events, hasLabel(/feature|enhancement/i), 6, () => 'Labeled as a feature or enhancement'),
    ...(versionBump
      ? [{ points: 6, reason: `Feature-level version bump ${versionBump.tagName}`, evidenceUrl: versionBump.url }]
      : []),
    ...firstMatch(
      s.events,
      (e) => e.kind === 'pull_request' && isFeatureTitle(e.title),
      5,
      () => 'Pull request adds new functionality',
    ),
    ...(isRoundup(s) ? roundupCapability(s) : countSignal(s, (e) => e.kind === 'pull_request' && isFeatureTitle(e.title), 3, 6, (n) => `${n} merged pull requests add functionality`)),
  ];
}

// ── Reliability and performance ──

const FIX_TITLE = /\b(fix(es|ed)?|bug(fix)?)\b/i;
const SEVERE_FAILURE = /regression|crash|panic|memory leak|deadlock|data loss|corrupt|segfault/i;
const RESILIENCE_TITLE = /\b(retr(y|ies|yable)|recover(y|s|ed)?|restart|timeouts?|resilien\w*|persist\w*|reconnect\w*|backoff|race|leak|bound(ed)?)\b/i;
const PERF_TITLE = /\b(perf(ormance)?|faster|speed ?up|latency|throughput)\b/i;

function reliability(s: Story): Signal[] {
  const patch = releaseOfType(s, 'patch');
  const fixRelease = stableReleases(s).find((e) => countBullets(e.body, FIX_BULLET) > 0);
  const fixCount = fixRelease ? countBullets(fixRelease.body, FIX_BULLET) : 0;
  return [
    ...(fixRelease
      ? [{ points: fixCount >= 5 ? 8 : 5, reason: `Release notes list ${fixCount} bug fix${fixCount === 1 ? '' : 'es'}`, evidenceUrl: fixRelease.url }]
      : []),
    ...firstMatch(s.events, (e) => FIX_TITLE.test(e.title), 5, () => 'Fixes a bug'),
    ...firstMatch(
      s.events,
      (e) => SEVERE_FAILURE.test(e.title) || hasLabel(SEVERE_FAILURE)(e),
      6,
      () => 'Addresses a regression, crash or data-integrity failure',
    ),
    ...firstMatch(s.events, (e) => PERF_TITLE.test(e.title), 5, () => 'Performance improvement'),
    ...firstMatch(s.events, hasLabel(/perf/i), 5, () => 'Labeled as performance work'),
    ...firstMatch(s.events, hasLabel(/\bbug\b/i), 4, () => 'Labeled as a bug'),
    ...(patch ? [{ points: 3, reason: `Patch release ${patch.tagName}`, evidenceUrl: patch.url }] : []),
    ...countSignal(s, (e) => e.kind === 'pull_request' && FIX_TITLE.test(e.title), 3, 4, (n) => `${n} merged pull requests fix problems`),
    ...countSignal(
      s,
      (e) => e.kind === 'pull_request' && !FIX_TITLE.test(e.title) && RESILIENCE_TITLE.test(e.title),
      3,
      4,
      (n) => `${n} merged pull requests improve recovery, retries or resilience`,
    ),
  ];
}

// ── Ecosystem significance ──

function starBand(stars: number): number {
  if (stars >= 50_000) return 6;
  if (stars >= 10_000) return 4;
  if (stars >= 1_000) return 2;
  return 0;
}

function ecosystem(s: Story): Signal[] {
  const signals: Signal[] = [];
  const shipped = stableReleases(s)[0] ?? s.events.find((e) => e.kind === 'advisory');
  const merged = s.events.find((e) => e.kind === 'pull_request' && e.state === 'merged');
  if (shipped) {
    signals.push({ points: 3, reason: `Shipped to users via ${shipped.kind === 'release' ? 'a release' : 'a published advisory'}`, evidenceUrl: shipped.url });
  } else if (merged) {
    signals.push({ points: 1, reason: 'Merged into the main codebase', evidenceUrl: merged.url });
  }
  const mergedPulls = s.events.filter((e) => e.kind === 'pull_request' && e.state === 'merged');
  if (mergedPulls.length >= 6) {
    signals.push({
      points: mergedPulls.length >= 20 ? 8 : mergedPulls.length >= 10 ? 5 : 3,
      reason: `${mergedPulls.length} pull requests merged in this window`,
      evidenceUrl: mergedPulls.at(-1)!.url,
    });
  }
  const busiest = [...s.events].sort((a, b) => engagement(b) - engagement(a))[0];
  if (busiest && engagement(busiest) >= 10) {
    signals.push({
      points: engagement(busiest) >= 50 ? 3 : 1,
      reason: `Community attention (${engagement(busiest)} comments and reactions)`,
      evidenceUrl: busiest.url,
    });
  }
  // Popularity only amplifies a change that already matters downstream (it
  // shipped, merged, or drew attention). Stars alone never earn points.
  const stars = Math.max(0, ...s.events.map((e) => e.repoStars ?? 0));
  if (signals.length > 0 && starBand(stars) > 0) {
    signals.push({
      points: starBand(stars),
      reason: `Change reaches a widely used repository (${stars.toLocaleString('en-US')} stars)`,
      evidenceUrl: `https://github.com/${s.repo}`,
    });
  }
  return signals;
}

/** A busy repository's roundup: credit the volume of product changes, whatever verbs the titles use. */
function roundupCapability(s: Story): Signal[] {
  const code = substantivePulls(s);
  if (code.length < 5) return [];
  return [
    {
      points: code.length >= 20 ? 15 : code.length >= 10 ? 12 : 8,
      reason: `${code.length} merged pull requests change the product (not docs, CI or tests)`,
      evidenceUrl: code.at(-1)!.url,
    },
  ];
}

/** Points for a story with several matching pull requests (roundups), beyond the single-event signal. */
function countSignal(s: Story, match: (e: RawEvent) => boolean, min: number, points: number, reason: (n: number) => string): Signal[] {
  const hits = s.events.filter(match);
  return hits.length >= min ? [{ points, reason: reason(hits.length), evidenceUrl: hits.at(-1)!.url }] : [];
}

const engagement = (e: RawEvent) => (e.comments ?? 0) + (e.reactions ?? 0);

// ── Personal relevance ──

const PRIORITY_POINTS: Record<number, number> = { 3: 5, 2: 3, 1: 1 };

function relevance(s: Story, ctx: RubricContext): Signal[] {
  const signals: Signal[] = [];
  const repoUrl = `https://github.com/${s.repo}`;
  if (ctx.repo) {
    const points = PRIORITY_POINTS[ctx.repo.priority] ?? 0;
    signals.push({ points, reason: `Watchlist priority ${ctx.repo.priority} repository`, evidenceUrl: repoUrl });
  }
  const interests = new Set(ctx.editorial.topics.map((t) => t.toLowerCase()));
  const storyTerms = [
    ...(ctx.repo?.topics ?? []),
    ...s.categories,
    ...(ctx.repo?.category ? [ctx.repo.category] : []),
    ...s.events.flatMap((e) => e.labels),
  ]
    // Categories like "Bitcoin, lightning" hold several terms.
    .flatMap((t) => t.toLowerCase().split(/\s*[,/|;]\s*/))
    .filter(Boolean);
  const overlap = [...new Set(storyTerms.filter((t) => interests.has(t)))].sort();
  if (overlap.length > 0) {
    signals.push({
      points: overlap.length >= 2 ? 5 : 3,
      reason: `Matches your topics: ${overlap.join(', ')}`,
      evidenceUrl: repoUrl,
    });
  }
  return signals;
}

export const DIMENSION_SIGNALS: Record<DimensionKey, (s: Story, ctx: RubricContext) => Signal[]> = {
  security,
  breaking,
  capability,
  reliability,
  ecosystem,
  relevance,
};
