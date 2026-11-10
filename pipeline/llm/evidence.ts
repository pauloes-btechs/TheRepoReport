/**
 * Evidence helpers shared by the prompt builder, the validator and the
 * deterministic fallback. Everything that came from GitHub is untrusted text;
 * these helpers only read and clean it, they never interpret it.
 */
import type { RawEvent, ScoredStory } from '../../shared/schemas';

export const EVIDENCE_OPEN = '<<<EVIDENCE';
export const EVIDENCE_CLOSE = '<<<END EVIDENCE>>>';

/** Remove control characters (keeps newline and tab), HTML comments, and our own delimiters. */
export function sanitizeUntrusted(text: string): string {
  return (
    text
      // HTML comments, including an unterminated trailing one.
      .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
      // C0 controls except \t and \n, DEL, C1 controls, bidi overrides and zero-width characters.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, '')
      // Anything that looks like our delimiters (or role/chat-template markers).
      .replace(/<<<\s*(END\s+)?EVIDENCE[^>]*>{0,3}/gi, ' ')
      .replace(/<{3,}|>{3,}/g, ' ')
      .replace(/<\|[^|>]{0,40}\|>/g, ' ')
      .replace(/\[\/?INST\]/gi, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** URLs the model is allowed to cite: event URLs, the status evidence URL and scorer evidence URLs. */
export function evidenceUrls(story: ScoredStory): Set<string> {
  const urls = new Set<string>();
  const add = (u: string | undefined) => {
    if (u) urls.add(normalizeUrl(u));
  };
  add(story.statusEvidenceUrl);
  for (const e of story.events) add(e.url);
  for (const d of story.score.dimensions) for (const s of d.signals) add(s.evidenceUrl);
  return urls;
}

export function normalizeUrl(url: string): string {
  return url.replace(/[).,;:!?'"\]]+$/, '').replace(/\/+$/, '').toLowerCase();
}

function eventFacts(e: RawEvent): string[] {
  return [
    e.id,
    e.kind,
    e.repo,
    e.number !== undefined ? `#${e.number}` : '',
    e.title,
    e.body,
    e.url,
    e.author ?? '',
    e.labels.join(' '),
    e.state,
    e.createdAt,
    e.updatedAt,
    e.mergedAt ?? '',
    e.publishedAt ?? '',
    e.tagName ?? '',
    e.severity ?? '',
    e.cveId ?? '',
    e.ghsaId ?? '',
    e.refs.join(' '),
  ];
}

/**
 * Every piece of evidence text for a story, joined. Used to check that
 * versions, identifiers and dates in model output were not invented. Includes
 * the deterministic scorer's signal reasons, which are derived from evidence.
 */
export function evidenceCorpus(story: ScoredStory): string {
  const parts: string[] = [story.repo, story.title, story.statusEvidenceUrl, ...story.categories];
  for (const e of story.events) parts.push(...eventFacts(e));
  for (const d of story.score.dimensions) for (const s of d.signals) parts.push(s.reason);
  return parts.filter(Boolean).join('\n');
}

/** Short repo name for prose: "ollama/ollama" → "ollama", "lightningnetwork/lnd" → "lnd". */
export function repoName(repo: string): string {
  return repo.split('/')[1] ?? repo;
}

/** The event that best represents the story's current status. */
export function primaryEvent(story: ScoredStory): RawEvent {
  const byUrl = story.events.find((e) => e.url === story.statusEvidenceUrl);
  if (byUrl) return byUrl;
  const order: RawEvent['kind'][] = ['advisory', 'release', 'pull_request', 'issue', 'discussion'];
  for (const kind of order) {
    const found = story.events.find((e) => e.kind === kind);
    if (found) return found;
  }
  return story.events[0]!;
}

/** YYYY-MM-DD of the event's most meaningful timestamp. */
export function eventDate(e: RawEvent): string {
  return (e.publishedAt ?? e.mergedAt ?? e.updatedAt ?? e.createdAt).slice(0, 10);
}
