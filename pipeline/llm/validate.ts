/**
 * The real defense against hallucination and prompt injection. The prompt asks
 * the model to behave; this module checks that it did, using only the evidence
 * the deterministic stages collected.
 */
import { LlmExplanation, STATUS_ORDER, type DevStatus, type ScoredStory } from '../../shared/schemas';
import { SECRET_PATTERNS } from '../util/redact';
import { evidenceCorpus, evidenceUrls, normalizeUrl } from './evidence';

export interface ValidationResult {
  ok: boolean;
  issues: string[];
  /** Parsed explanation when the JSON matched the schema (even if other checks failed). */
  value?: LlmExplanation;
}

/** Remove Qwen3-style reasoning blocks (including an unterminated one) and code fences. */
export function stripThinking(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = text.search(/<think>/i);
  if (open >= 0) text = text.slice(0, open);
  text = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  // Tolerate leading/trailing chatter around a single JSON object.
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  return text;
}

/** Every human-readable string in an explanation, labeled by field. */
export function textFields(x: LlmExplanation): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [
    { field: 'headline', text: x.headline },
    { field: 'whatHappened', text: x.whatHappened },
    { field: 'previously', text: x.previously },
    { field: 'whatChanged', text: x.whatChanged },
    { field: 'whyItMatters', text: x.whyItMatters },
    { field: 'nextConfirmed', text: x.nextConfirmed },
    { field: 'nextSpeculative', text: x.nextSpeculative },
    { field: 'analogy', text: x.analogy },
    { field: 'intermediate', text: x.intermediate },
    { field: 'technical', text: x.technical },
  ];
  x.glossary.forEach((g, i) => {
    out.push({ field: `glossary[${i}].term`, text: g.term });
    out.push({ field: `glossary[${i}].definition`, text: g.definition });
  });
  return out;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi;
/** Defanged links ("hxxps://", "example[.]com") are never legitimate in our output. */
const DEFANGED_RE = /\bhxxps?:\/\/|\[\.\]|\(\.\)|\[dot\]/i;
/**
 * Bare domains such as "evil-mirror.example.net/install". Limited to common
 * TLDs so file names (README.md, next.js, install.sh) are not mistaken for hosts.
 */
const BARE_DOMAIN_RE =
  /(?<![\w@/.-])((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|co|ai|xyz|info|biz|cloud|site|online|ru|cn|tk|top|link|page|gg|me|us|uk|de))(?![\w-])(?:\/[^\s<>"'`)\]]*)?/gi;
const VERSION_RE = /(?<![\w.])v?(\d+\.\d+(?:\.\d+)?)(?![\d])/gi;
const CVE_RE = /\bCVE-\d{4}-\d{4,}\b/gi;
const GHSA_RE = /\bGHSA(?:-[0-9a-z]{4}){3}\b/gi;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;
const MONTH_ALT = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_DAY_RE = new RegExp(`\\b${MONTH_ALT}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi');
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_ALT}\\.?(?:,?\\s+(\\d{4}))?\\b`, 'gi');
const YEAR_RE = /(?<![\w.-])((?:19|20)\d{2})(?![\w-]|\.\d)/g;

function monthIndex(name: string): number {
  const lower = name.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(lower));
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Words that, immediately before a status verb, make the claim negated,
 * conditional or future ("has not been released", "once it is released").
 * Deliberately excludes words like "no", "can", "after" that occur in
 * affirmative claims ("with no setup, it is now available").
 */
const HEDGE_RE =
  /\b(not|never|yet|until|unless|once|when|whenever|if|before|will|would|could|might|may|cannot|awaiting|pending|eventually|expected|planned|proposed|to be)\b|n't\b/i;
/** How many words before a claim are checked for a hedge. */
const HEDGE_WORDS = 4;

/** Claim patterns per status level, and the minimum classified status that allows them. */
const STATUS_CLAIMS: { min: DevStatus; label: string; re: RegExp }[] = [
  {
    min: 'deployed',
    label: 'deployed',
    re: /\b(has been deployed|is deployed|now deployed|was deployed|confirmed deployed|running in production|live in production|rolled out to (?:all )?users)\b/gi,
  },
  {
    min: 'released',
    label: 'released / available',
    re: /\b(released|now available|available now|is available|are available|generally available|out now|is live|went live|now live|shipped|ships|rolled out|you can now (?:download|upgrade|install|update|use|get)|available to (?:download|install|users|everyone)|ready to (?:download|install)|in the latest release|new release is out|(?:install|download|use|try) it (?:out )?(?:today|now)|(?:in|part of) the (?:newest|latest) version|can (?:now )?(?:download|install|upgrade to|update to) (?:it|the new version|version))\b/gi,
  },
  {
    min: 'merged',
    label: 'merged / accepted',
    re: /\b(merged|has been accepted|was accepted|were accepted|got accepted|has landed|have landed|landed in|is now part of|are now part of|added to the main code|approved and merged|committed to the main)\b/gi,
  },
];

/** True when the claim at `index` sits in a negated or hypothetical clause. */
function isHedged(text: string, index: number): boolean {
  const sentenceStart = Math.max(
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf('?', index - 1),
    text.lastIndexOf(';', index - 1),
    text.lastIndexOf(':', index - 1),
  );
  const before = text.slice(sentenceStart + 1, index).trim().split(/\s+/).slice(-HEDGE_WORDS).join(' ');
  return HEDGE_RE.test(before);
}

const INJECTION_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'instruction override', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|the)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|directions)\b/i },
  { label: 'system prompt reference', re: /\bsystem prompt\b|\bsystem message\b|\bdeveloper message\b/i },
  { label: 'model self-reference', re: /\bas an ai\b|\bas a (large )?language model\b|\bi am an ai\b|\bi'm an ai\b|\bi cannot comply\b|\bi can't help with\b/i },
  { label: 'delimiter leak', re: /<<<|>>>|END EVIDENCE|BEGIN EVIDENCE/i },
  { label: 'chat-template marker', re: /<\|[^|]{0,30}\|>|\[\/?INST\]|<\/?s>|<\/?(system|assistant|user)>/i },
  { label: 'role marker', re: /(^|\n)\s*(system|assistant|user|human)\s*:/i },
  { label: 'jailbreak phrasing', re: /\bjailbreak\b|\bdeveloper mode\b|\bDAN mode\b|\bnew instructions\b/i },
  { label: 'credential request', re: /\b(api[ -]?key|password|private key|seed phrase|mnemonic|access token)s?\b[^.\n]{0,30}\b(send|share|enter|paste|post|provide)\b|\b(send|share|enter|paste|post|provide)\b[^.\n]{0,30}\b(api[ -]?key|password|private key|seed phrase|mnemonic|access token)s?\b/i },
];

const STOPWORDS = new Set(
  'the a an and or but for nor of on in to into at by with from as is are was were be been being this that these those it its new now not no yes can will may might should would could has have had do does did over under about after before more most less via per than then there their they them you your our we us i he she his her who what when where why how which all any some update updates updated adds add added fix fixes fixed change changes changed version release releases released support supports'.split(
    ' ',
  ),
);

export function meaningfulWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function wordsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

function statusRank(s: DevStatus): number {
  return STATUS_ORDER.indexOf(s);
}

/** Validate an already-parsed object (or a raw model string) against the story's evidence. */
export function validateExplanation(raw: unknown, story: ScoredStory): ValidationResult {
  const issues: string[] = [];
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(stripThinking(raw));
    } catch {
      return { ok: false, issues: ['Output is not valid JSON.'] };
    }
  }
  const parsed = LlmExplanation.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 8)) {
      issues.push(`Schema: ${issue.path.join('.') || '(root)'} ${issue.message}.`);
    }
    return { ok: false, issues };
  }
  const value = parsed.data;
  issues.push(...checkAgainstEvidence(value, story));
  return { ok: issues.length === 0, issues, value };
}

/** Evidence checks on a schema-valid explanation. Returns human-readable issues. */
export function checkAgainstEvidence(x: LlmExplanation, story: ScoredStory): string[] {
  const issues: string[] = [];
  const allowedUrls = evidenceUrls(story);
  const allowedHosts = new Set(
    ['github.com', ...[...allowedUrls].map((u) => hostOf(u))].filter((h): h is string => !!h),
  );
  const corpus = evidenceCorpus(story);
  const corpusLower = corpus.toLowerCase();
  const corpusIsoDates = new Set(corpus.match(/\d{4}-\d{2}-\d{2}/g) ?? []);
  const corpusYears = new Set(corpus.match(/(?:19|20)\d{2}/g) ?? []);
  const seen = new Set<string>();
  const add = (msg: string) => {
    if (!seen.has(msg)) {
      seen.add(msg);
      issues.push(msg);
    }
  };

  for (const { field, text } of textFields(x)) {
    if (!text) continue;

    for (const m of text.matchAll(URL_RE)) {
      const url = normalizeUrl(m[0].startsWith('www.') ? `https://${m[0]}` : m[0]);
      const ok = [...allowedUrls].some((a) => a === url || a.replace(/^https?:\/\//, '') === url.replace(/^https?:\/\//, ''));
      // The URL itself is not echoed: notes are published, and the URL may be hostile.
      if (!ok) add(`${field}: contains a link that is not one of the evidence URLs; remove it.`);
    }
    // Remove URLs before scanning for versions/dates so their path segments are not double-counted.
    const plain = text.replace(URL_RE, ' ');

    if (DEFANGED_RE.test(plain)) add(`${field}: contains an obfuscated link; remove it.`);
    for (const m of plain.matchAll(BARE_DOMAIN_RE)) {
      const host = m[1]!.toLowerCase().replace(/^www\./, '');
      if (!allowedHosts.has(host)) add(`${field}: mentions a web address that is not in the evidence; remove it.`);
    }
    for (const pattern of SECRET_PATTERNS) {
      if (new RegExp(pattern.regex.source, 'i').test(text)) add(`${field}: contains a credential-like string; remove it.`);
    }

    for (const m of plain.matchAll(VERSION_RE)) {
      const token = m[1]!;
      const re = new RegExp(`(?<![\\d.])v?${escapeRe(token)}(?!\\d)`, 'i');
      if (!re.test(corpus)) add(`${field}: version or number "${m[0]}" does not appear in the evidence.`);
    }
    for (const m of plain.matchAll(CVE_RE)) {
      if (!corpusLower.includes(m[0].toLowerCase())) add(`${field}: ${m[0]} does not appear in the evidence.`);
    }
    for (const m of plain.matchAll(GHSA_RE)) {
      if (!corpusLower.includes(m[0].toLowerCase())) add(`${field}: ${m[0]} does not appear in the evidence.`);
    }
    for (const m of plain.matchAll(ISO_DATE_RE)) {
      if (!corpusIsoDates.has(m[0])) add(`${field}: date ${m[0]} does not appear in the evidence.`);
    }
    for (const re of [MONTH_DAY_RE, DAY_MONTH_RE]) {
      for (const m of plain.matchAll(re)) {
        const monthName = re === MONTH_DAY_RE ? m[1]! : m[2]!;
        const day = Number(re === MONTH_DAY_RE ? m[2] : m[1]);
        const year = m[3];
        const month = monthIndex(monthName) + 1;
        if (month < 1 || day < 1 || day > 31) continue;
        const md = `-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const found =
          [...corpusIsoDates].some((d) => d.endsWith(md) && (!year || d.startsWith(year))) ||
          corpusLower.includes(m[0].toLowerCase());
        if (!found) add(`${field}: date "${m[0]}" does not appear in the evidence.`);
      }
    }
    for (const m of plain.replace(ISO_DATE_RE, ' ').matchAll(YEAR_RE)) {
      if (!corpusYears.has(m[1]!)) add(`${field}: year ${m[1]} does not appear in the evidence.`);
    }

    for (const claim of STATUS_CLAIMS) {
      if (statusRank(story.status) >= statusRank(claim.min)) continue;
      claim.re.lastIndex = 0;
      for (const m of text.matchAll(claim.re)) {
        if (isHedged(text, m.index ?? 0)) continue;
        add(
          `${field}: says "${m[0]}" but the classified status is "${story.status}"; do not claim ${claim.label}.`,
        );
      }
    }

    for (const p of INJECTION_PATTERNS) {
      if (p.re.test(text)) add(`${field}: contains instruction-like or off-topic text (${p.label}).`);
    }
  }

  // Off-topic: the headline must share a meaningful word with the evidence titles or repo name.
  const anchor = new Set(
    meaningfulWords(
      [story.repo.replace(/[/_-]/g, ' '), story.title, ...story.events.map((e) => `${e.title} ${e.tagName ?? ''}`)].join(' '),
    ),
  );
  const headlineWords = meaningfulWords(x.headline);
  if (!headlineWords.some((w) => [...anchor].some((a) => wordsOverlap(w, a)))) {
    add('headline: shares no meaningful words with the evidence titles or repository name (possibly off-topic).');
  }

  return issues;
}
