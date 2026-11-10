/**
 * Pronunciation pass: turns display text into something a speech engine reads
 * naturally. Deterministic and config-driven (editorial.lexicon).
 */

const NOT_REPOS = new Set([
  'and/or', 'either/or', 'he/she', 'his/her', 'yes/no', 'on/off', 'true/false', 'read/write',
  'input/output', 'client/server', 'pros/cons', 'w/o',
]);

/** Always applied; config entries override. */
export const BUILTIN_LEXICON: Record<string, string> = { TheRepoReport: 'The Repo Report' };

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "lightningnetwork/lnd" → "lnd"; "OHF-Voice/piper1-gpl" → "piper1 gpl". */
export function speakRepo(slug: string): string {
  const name = slug.split('/')[1] ?? slug;
  return name.replace(/\.(js|ts|py|rs|go)$/i, ' $1').replace(/[-_.]+/g, ' ').trim();
}

/** "v0.9.1" → "version 0 point 9 point 1"; "-rc.1" suffix → "release candidate 1". */
export function speakVersion(core: string, suffix = ''): string {
  let spoken = core.split('.').join(' point ');
  if (suffix) {
    const s = suffix
      .replace(/^[-+.]/, '')
      .replace(/\brc\b|^rc(?=\d|\.|$)/i, 'release candidate ')
      .replace(/[-.+_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (s) spoken += ` ${s}`;
  }
  return spoken;
}

function speakIsoDate(y: string, m: string, d: string): string {
  const month = MONTHS[Number(m) - 1];
  if (!month) return `${y} ${m} ${d}`;
  return `${month} ${Number(d)}, ${y}`;
}

function spellDigits(digits: string): string {
  return digits
    .split('')
    .map((c) => ONES[Number(c)] ?? c)
    .join(' ');
}

/** Strip markdown formatting, keep the words. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '');
}

/**
 * Prepare display text for the speech engine. Order matters: URLs and
 * markdown go first, then structured tokens (repos, dates, versions, IDs),
 * then the lexicon in a single pass so replacements never cascade.
 */
export function pronounce(text: string, userLexicon: Record<string, string> = {}): string {
  const lexicon: Record<string, string> = { ...BUILTIN_LEXICON, ...userLexicon };
  let t = stripMarkdown(text);
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, ' ');
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u001F\u007F]/g, ' ');

  // owner/repo → repo name (a slug-specific lexicon entry wins).
  t = t.replace(/(?<![\w./-])([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9])(?![\w/-])/g, (m, owner: string, name: string) => {
    if (NOT_REPOS.has(m.toLowerCase())) return m.toLowerCase() === 'and/or' ? m.replace('/', ' ') : m.replace('/', ' or ');
    if (!/[A-Za-z]/.test(owner) || !/[A-Za-z]/.test(name)) return m;
    if (lexicon[m]) return lexicon[m]!;
    return speakRepo(`${owner}/${name}`);
  });

  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?\b/g, (_m, y: string, mo: string, d: string) => speakIsoDate(y, mo, d));
  t = t.replace(/\bCVE-(\d{4})-(\d+)\b/gi, (_m, y: string, n: string) => `C V E ${y} dash ${spellDigits(n)}`);
  t = t.replace(/\bGHSA(?:-[0-9a-z]{4}){3}\b/gi, 'G H S A advisory');
  t = t.replace(/(^|[^\w&])#(\d+)\b/g, (_m, pre: string, n: string) => `${pre}number ${n}`);

  // Versions: "v0.9.1" → "version 0 point 9 point 1"; bare "2.8.3" → "2 point 8 point 3".
  t = t.replace(
    /(?<![\w.])(version\s+)?(v)?(\d+(?:\.\d+)+)((?:-(?:rc|beta|alpha|pre|preview)[.\d]*)|-[a-z]+\.?\d*)?(?![\w.]*\d)/gi,
    (m, versionWord: string | undefined, v: string | undefined, core: string, suffix: string | undefined) => {
      if (!v && !versionWord && !core.includes('.')) return m;
      const spoken = speakVersion(core, suffix ?? '');
      if (versionWord) return `${versionWord}${spoken}`;
      return v ? `version ${spoken}` : spoken;
    },
  );

  t = t
    .replace(/\be\.g\.,?/gi, 'for example,')
    .replace(/\bi\.e\.,?/gi, 'that is,')
    .replace(/\betc\./gi, 'and so on.')
    .replace(/\s&\s/g, ' and ')
    .replace(/(\d)\s?%/g, '$1 percent')
    .replace(/[→⇒➜]/g, ' to ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[<>{}[\]|\\^~*_=`]/g, ' ');

  const keys = Object.keys(lexicon)
    .filter((k) => k && !k.includes('/'))
    .sort((a, b) => b.length - a.length);
  if (keys.length) {
    const re = new RegExp(`(?<![A-Za-z0-9])(${keys.map(escapeRe).join('|')})(s?)(?![A-Za-z0-9])`, 'g');
    t = t.replace(re, (_m, key: string, plural: string) => `${lexicon[key] ?? key}${plural}`);
  }

  return t
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/([.,!?;:])(?=[A-Za-z])/g, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
