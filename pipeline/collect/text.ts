import { redact } from '../util/redact';
/**
 * Text hygiene for untrusted GitHub content, and cross-reference extraction.
 * Everything fetched from GitHub is data: we only clean and shorten it here.
 */

export const MAX_BODY_CHARS = 1500;

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
// C0/C1 control characters except tab and newline, plus zero-width and bidi overrides.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

/** Strips HTML comments and control characters, collapses blank runs and truncates. */
export function sanitizeText(input: string | null | undefined, maxChars = MAX_BODY_CHARS): string {
  if (!input) return '';
  // Untrusted text must never carry a credential-shaped string: the publish-time
  // secret scan would fail every run until the item aged out (a denial of service
  // anyone could trigger with a PR title).
  const cleaned = redact(input)
    .replace(/\r\n?/g, '\n')
    .replace(HTML_COMMENT, '')
    .replace(CONTROL_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Single-line variant for titles. */
export function sanitizeTitle(input: string | null | undefined): string {
  return sanitizeText(input, 300).replace(/\s+/g, ' ');
}

const SLUG = '[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+';
const URL_REF = new RegExp(`https?:\\/\\/github\\.com\\/(${SLUG})\\/(?:pull|issues)\\/(\\d+)`, 'gi');
const SLUG_REF = new RegExp(`(?<![\\w/.-])(${SLUG})#(\\d+)\\b`, 'g');
// A bare "#123" not preceded by a word char, "&" (HTML entity) or "/" (URL fragment).
const BARE_REF = /(?<![\w&/#])#(\d+)\b/g;

/**
 * Finds references to issues and pull requests, normalized to "owner/repo#N".
 * Bare "#N" refers to `repo`. `self` (e.g. "owner/repo#12") is excluded.
 */
export function extractRefs(text: string, repo: string, self?: string): string[] {
  const refs = new Set<string>();
  let rest = text;
  for (const m of text.matchAll(URL_REF)) {
    refs.add(`${m[1]}#${Number(m[2])}`);
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(SLUG_REF)) refs.add(`${m[1]}#${Number(m[2])}`);
  const withoutSlugRefs = rest.replace(SLUG_REF, ' ');
  for (const m of withoutSlugRefs.matchAll(BARE_REF)) refs.add(`${repo}#${Number(m[1])}`);

  const selfKey = self?.toLowerCase();
  return [...refs].filter((ref) => ref.toLowerCase() !== selfKey).sort();
}
