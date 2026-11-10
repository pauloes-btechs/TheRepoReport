/**
 * Deterministic grouping of events into connected components: explicit
 * references first, then stories already known from state, then a
 * conservative title-similarity pass for stragglers.
 */
import type { PipelineState, RawEvent } from '../../shared/schemas';
import { PATCHED_PREFIX } from '../collect/normalize';

class UnionFind {
  private parent = new Map<string, string>();

  add(node: string): void {
    if (!this.parent.has(node)) this.parent.set(node, node);
  }

  find(node: string): string {
    this.add(node);
    let root = node;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression keeps repeated lookups cheap.
    let cur = node;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Deterministic: the lexicographically smaller root wins.
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

export const KNOWN_PREFIX = 'known:';

export interface Component {
  events: RawEvent[];
  /** Known story ids folded into this component. */
  knownIds: string[];
}

const lower = (s: string) => s.toLowerCase();

function issueKey(e: RawEvent): string | undefined {
  if ((e.kind === 'pull_request' || e.kind === 'issue') && e.number !== undefined) return lower(`${e.repo}#${e.number}`);
  return undefined;
}

/** Event ids an "owner/repo#N" reference could point at. */
function idsForRef(ref: string): string[] {
  return [`pull_request:${ref}`, `issue:${ref}`].map(lower);
}

export function groupEvents(events: RawEvent[], known: PipelineState['stories']): Component[] {
  const uf = new UnionFind();
  const byKey = new Map<string, RawEvent>();
  const knownByEventId = new Map<string, string>();

  for (const [storyId, story] of Object.entries(known)) {
    for (const eventId of story.eventIds) knownByEventId.set(lower(eventId), storyId);
  }
  for (const e of events) {
    uf.add(e.id);
    const key = issueKey(e);
    if (key) byKey.set(key, e);
    const knownId = knownByEventId.get(lower(e.id));
    if (knownId) uf.union(e.id, KNOWN_PREFIX + knownId);
  }

  for (const e of events) linkReferences(e, uf, byKey, knownByEventId);
  linkReleasesByTitle(events, uf);
  linkAdvisoriesToReleases(events, uf);
  linkSimilarTitles(events, known, uf);

  const groups = new Map<string, Component>();
  const componentFor = (node: string) => {
    const root = uf.find(node);
    let group = groups.get(root);
    if (!group) {
      group = { events: [], knownIds: [] };
      groups.set(root, group);
    }
    return group;
  };
  for (const e of events) componentFor(e.id).events.push(e);
  for (const storyId of Object.keys(known)) {
    const node = KNOWN_PREFIX + storyId;
    // Only known stories that touched today's events become part of a component.
    if (groups.has(uf.find(node))) componentFor(node).knownIds.push(storyId);
  }
  return [...groups.values()].filter((g) => g.events.length > 0);
}

/**
 * Links an event to what it references. Issue-to-issue mentions are ignored:
 * "see also #12" between two issues is too weak to call them one story.
 */
function linkReferences(
  e: RawEvent,
  uf: UnionFind,
  byKey: Map<string, RawEvent>,
  knownByEventId: Map<string, string>,
): void {
  for (const ref of e.refs) {
    const target = byKey.get(lower(ref));
    if (target && target.id !== e.id && !(e.kind === 'issue' && target.kind === 'issue')) {
      uf.union(e.id, target.id);
    }
    for (const candidate of idsForRef(ref)) {
      if (e.kind === 'issue' && candidate.startsWith('issue:')) continue;
      const knownId = knownByEventId.get(candidate);
      if (knownId) uf.union(e.id, KNOWN_PREFIX + knownId);
    }
  }
}

const MIN_TITLE_MATCH_CHARS = 15;

/** Release notes often quote a PR title without its number. */
function linkReleasesByTitle(events: RawEvent[], uf: UnionFind): void {
  const releases = events.filter((e) => e.kind === 'release');
  const pulls = events.filter((e) => e.kind === 'pull_request' && e.state === 'merged');
  for (const release of releases) {
    const notes = normalizeText(release.body);
    for (const pull of pulls) {
      if (lower(pull.repo) !== lower(release.repo)) continue;
      const title = normalizeText(stripConventionalPrefix(pull.title));
      if (title.length >= MIN_TITLE_MATCH_CHARS && notes.includes(title)) uf.union(release.id, pull.id);
    }
  }
}

const VERSION = /\d+\.\d+(?:\.\d+)?/g;
const versionOf = (tag: string | undefined) => tag?.match(/\d+\.\d+(?:\.\d+)?/)?.[0];

/**
 * A security fix ships as an advisory plus the release(s) that patch it. Link
 * them when the advisory lists the release's version as patched, or when the
 * release notes cite the advisory's GHSA or CVE id.
 */
function linkAdvisoriesToReleases(events: RawEvent[], uf: UnionFind): void {
  const releases = events.filter((e) => e.kind === 'release');
  for (const advisory of events.filter((e) => e.kind === 'advisory')) {
    const patchedLine = advisory.body.startsWith(PATCHED_PREFIX) ? advisory.body.split('\n', 1)[0]! : '';
    const patched = new Set(patchedLine.match(VERSION) ?? []);
    const ids = [advisory.ghsaId, advisory.cveId].filter((id): id is string => !!id).map(lower);
    for (const release of releases) {
      if (lower(release.repo) !== lower(advisory.repo)) continue;
      const version = versionOf(release.tagName);
      const cited = ids.some((id) => lower(release.body).includes(id));
      if ((version && patched.has(version)) || cited) uf.union(advisory.id, release.id);
    }
  }
}

const SIMILARITY_THRESHOLD = 0.8;
const MIN_TOKENS = 3;
const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'is', 'be', 'when']);

/**
 * Last resort for events no reference connected: same-repo PRs/issues whose
 * normalized titles are near-identical. Releases and advisories are excluded
 * because their titles ("v1.2.3") are not descriptive enough.
 */
function linkSimilarTitles(events: RawEvent[], known: PipelineState['stories'], uf: UnionFind): void {
  const candidates = events.filter((e) => e.kind === 'pull_request' || e.kind === 'issue');
  const knownTitles = Object.entries(known).map(([id, s]) => ({ node: KNOWN_PREFIX + id, repo: s.repo, title: s.title }));
  const componentSize = new Map<string, number>();
  for (const node of [...events.map((e) => e.id), ...knownTitles.map((k) => k.node)]) {
    const root = uf.find(node);
    componentSize.set(root, (componentSize.get(root) ?? 0) + 1);
  }
  const isolated = candidates.filter((e) => componentSize.get(uf.find(e.id)) === 1);

  for (const e of isolated) {
    const tokens = titleTokens(e.title);
    if (tokens.size < MIN_TOKENS) continue;
    const peers = [
      ...candidates.filter((o) => o !== e).map((o) => ({ node: o.id, repo: o.repo, title: o.title })),
      ...knownTitles,
    ];
    for (const peer of peers) {
      if (lower(peer.repo) !== lower(e.repo)) continue;
      if (jaccard(tokens, titleTokens(peer.title)) >= SIMILARITY_THRESHOLD) {
        uf.union(e.id, peer.node);
        break;
      }
    }
  }
}

function stripConventionalPrefix(title: string): string {
  return title.replace(/^\s*\w+(\([^)]*\))?!?:\s*/, '');
}

function normalizeText(text: string): string {
  return lower(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function titleTokens(title: string): Set<string> {
  return new Set(
    normalizeText(stripConventionalPrefix(title))
      .split(' ')
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size < MIN_TOKENS || b.size < MIN_TOKENS) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}
