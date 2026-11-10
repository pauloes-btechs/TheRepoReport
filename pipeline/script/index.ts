/**
 * pipeline/script — turn explained stories into a broadcast script:
 * intro → headlines → lead → remaining stories → why it matters → worth
 * watching → closing. Every sentence is built from the explanations and
 * evidence fields; nothing is invented to fill time.
 */
import type { BuildScript, ScriptInput } from '../../shared/contracts';
import { EDITION_GREETINGS, EDITION_TITLES } from '../../shared/edition';
import {
  STATUS_ORDER,
  type DevStatus,
  type EditionName,
  type ExplainedStory,
  type ScoredStory,
  type ScriptSegment,
} from '../../shared/schemas';
import { repoName, sanitizeUntrusted, truncate } from '../llm/evidence';
import { pronounce } from './pronounce';

export { pronounce, speakRepo, speakVersion, stripMarkdown } from './pronounce';

export const WORDS_PER_MINUTE = 150;
export const MAX_HEADLINES = 5;
export const MAX_WATCH_ITEMS = 5;

export const EDITION_FRAMING: Record<EditionName, string> = {
  morning: "Here are the overnight developments from the repositories you follow.",
  afternoon: "Here's what's changed since this morning in the repositories you follow.",
  evening: "Here's the day's recap from the repositories you follow.",
};

const SIGN_OFF: Record<EditionName, string> = {
  morning: "We'll be back this afternoon.",
  afternoon: "We'll be back this evening.",
  evening: "We'll be back tomorrow morning.",
};

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];

type StoryForm = 'full' | 'medium' | 'short';

export function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

/** Estimated listening time in minutes at 150 words per minute. */
export function estimateMinutes(segments: Pick<ScriptSegment, 'spokenText'>[]): number {
  return segments.reduce((n, s) => n + wordCount(s.spokenText), 0) / WORDS_PER_MINUTE;
}

function sentence(text: string): string {
  const t = text.trim();
  if (!t) return '';
  return /[.!?]["')]?$/.test(t) ? t : `${t}.`;
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function topicLabel(topic: string): string {
  const t = topic.replace(/[-_]+/g, ' ').trim();
  return t.length <= 3 ? t.toUpperCase() : t;
}

function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim());
  return sentence(m ? m[0] : text);
}

function joinSentences(parts: (string | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map(sentence).join(' ');
}

function longDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

function statusLine(status: DevStatus): string {
  switch (status) {
    case 'proposed':
      return 'Status: Proposed. This is a proposal; it has not been merged or released';
    case 'in_development':
      return 'Status: In development. Work is ongoing; it has not been merged or released';
    case 'merged':
      return 'Status: Merged. It is in the main code but not yet in a release';
    case 'released':
      return 'Status: Released. It is in a published version';
    case 'deployed':
      return 'Status: Confirmed deployed';
  }
}

function storyText(story: ExplainedStory, form: StoryForm, lead: boolean): string {
  const x = story.explanation;
  const parts: (string | false)[] = [
    lead && 'Our lead story',
    x.headline,
    `From ${story.repo}`,
    statusLine(story.status),
    x.whatHappened,
  ];
  if (form === 'full') {
    if (x.source === 'llm') parts.push(`Previously: ${x.previously}`);
    parts.push(`What changed: ${x.whatChanged}`);
    if (x.glossary.length) {
      parts.push('A few terms');
      for (const g of x.glossary) parts.push(`${capitalize(g.term)}: ${g.definition}`);
    }
    if (x.analogy) parts.push(`Think of it this way: ${x.analogy}`);
  }
  if (form !== 'short') {
    parts.push(`Why it matters: ${x.whyItMatters}`);
    if (x.nextConfirmed) parts.push(`What's confirmed next: ${x.nextConfirmed}`);
  }
  if (form === 'full' && x.nextSpeculative) {
    parts.push(`What might happen, and this is not confirmed: ${x.nextSpeculative}`);
  }
  return joinSentences(parts);
}

function topicMatches(stories: ExplainedStory[], topics: string[]): { topic: string; stories: ExplainedStory[] }[] {
  const out: { topic: string; stories: ExplainedStory[] }[] = [];
  for (const topic of topics) {
    const words = topic.toLowerCase().replace(/[-_]+/g, ' ').trim();
    if (!words) continue;
    const re = new RegExp(`(?<![a-z0-9])${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s_-]+')}(?![a-z0-9])`, 'i');
    const hits = stories.filter((s) => {
      const relevance = s.score.dimensions.find((d) => d.key === 'relevance')?.signals.map((g) => g.reason) ?? [];
      const hay = [
        ...s.categories,
        s.repo,
        s.explanation.headline,
        s.explanation.whatHappened,
        s.explanation.whyItMatters,
        ...relevance,
      ].join(' \n ');
      return re.test(hay);
    });
    if (hits.length) out.push({ topic, stories: hits });
  }
  return out.sort((a, b) => b.stories.length - a.stories.length);
}

function whyText(stories: ExplainedStory[], topics: string[]): string {
  const matches = topicMatches(stories, topics).slice(0, 3);
  if (!matches.length) {
    return joinSentences([
      topics.length
        ? `None of these stories map directly onto the topics you follow: ${topics.map(topicLabel).join(', ')}`
        : 'You have not listed any topics yet',
      'Each one comes from a repository on your watchlist and cleared the impact threshold',
    ]);
  }
  const parts: string[] = [];
  for (const m of matches) {
    const names = [...new Set(m.stories.map((s) => repoName(s.repo)))];
    const count = m.stories.length === 1 ? 'One story in this edition touches' : `${m.stories.length} stories in this edition touch`;
    parts.push(`You follow ${topicLabel(m.topic)}. ${count} on it, from ${names.join(', ')}`);
    const top = m.stories[0]!;
    parts.push(`For ${repoName(top.repo)}: ${firstSentence(top.explanation.whyItMatters)}`);
  }
  return joinSentences(parts);
}

function watchTitle(story: ScoredStory): string {
  return truncate(
    sanitizeUntrusted(story.title)
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim(),
    120,
  );
}

function watchText(watching: ScoredStory[]): string {
  const items = watching.slice(0, MAX_WATCH_ITEMS);
  const allUnreleased = items.every((w) => STATUS_ORDER.indexOf(w.status) < STATUS_ORDER.indexOf('released'));
  const parts: string[] = [
    allUnreleased
      ? 'Worth watching. These items are still in progress: none of them is in a release yet, and plans can change'
      : 'Worth watching. These items are still developing, and plans can change',
  ];
  for (const w of items) {
    parts.push(`From ${w.repo}: ${watchTitle(w)}`);
    parts.push(statusLine(w.status));
  }
  if (watching.length > items.length) parts.push(`Plus ${watching.length - items.length} more on the site`);
  return joinSentences(parts);
}

function closingText(stories: ExplainedStory[], edition: EditionName, quiet: boolean): string {
  const parts: string[] = [];
  if (!quiet) {
    const take = stories.slice(0, 3);
    const label = take.length === 1 ? 'One takeaway' : `${take.length === 2 ? 'Two' : 'Three'} takeaways`;
    parts.push(label);
    for (const s of take) parts.push(`${capitalize(repoName(s.repo))}: ${firstSentence(s.explanation.whyItMatters)}`);
  } else {
    parts.push("That's all for this window");
  }
  parts.push(`That's TheRepoReport for this ${EDITION_TITLES[edition].toLowerCase()}`);
  parts.push('Every story comes with its GitHub sources on the site');
  parts.push(SIGN_OFF[edition]);
  return joinSentences(parts);
}

function introText(input: ScriptInput, quiet: boolean): string {
  const n = input.stories.length;
  return joinSentences([
    `${EDITION_GREETINGS[input.edition]}. You're listening to TheRepoReport, your personal AI-powered GitHub newsroom`,
    `This is the ${EDITION_TITLES[input.edition]} for ${longDate(input.date)}`,
    EDITION_FRAMING[input.edition],
    !quiet && (n === 1 ? 'We have one story for you' : `We have ${n} stories for you`),
  ]);
}

function headlinesText(stories: ExplainedStory[]): string {
  const top = stories.slice(0, MAX_HEADLINES);
  if (top.length === 1) return joinSentences(["Here's the top headline", top[0]!.explanation.headline]);
  return joinSentences([
    'Here are the top headlines',
    ...top.map((s, i) => `${ORDINALS[i] ?? 'Next'}: ${s.explanation.headline}`),
  ]);
}

function seg(
  id: string,
  kind: ScriptSegment['kind'],
  title: string,
  text: string,
  lexicon: Record<string, string>,
  storyId?: string,
): ScriptSegment {
  const s: ScriptSegment = { id, kind, title, text, spokenText: pronounce(text, lexicon) };
  if (storyId) s.storyId = storyId;
  return s;
}

function assemble(input: ScriptInput, forms: StoryForm[]): ScriptSegment[] {
  const { stories, watching, editorial } = input;
  const lex = editorial.lexicon;
  const quiet = stories.length === 0;
  const out: ScriptSegment[] = [seg('intro', 'intro', 'Welcome', introText(input, quiet), lex)];

  if (quiet) {
    out.push(
      seg(
        'quiet',
        'headlines',
        'Quiet window',
        joinSentences([
          'No significant developments cleared our threshold in this window',
          'Rather than pad the show, we will keep it short',
        ]),
        lex,
      ),
    );
  } else {
    out.push(seg('headlines', 'headlines', 'Top headlines', headlinesText(stories), lex));
    stories.forEach((story, i) => {
      const lead = i === 0;
      out.push(
        seg(
          lead ? 'lead' : `story-${i + 1}`,
          lead ? 'lead' : 'story',
          story.explanation.headline,
          storyText(story, forms[i] ?? 'short', lead),
          lex,
          story.id,
        ),
      );
    });
    out.push(seg('why', 'why', 'Why it matters to you', whyText(stories, editorial.topics), lex));
  }
  if (watching.length) out.push(seg('watching', 'watching', 'Worth watching', watchText(watching), lex));
  out.push(seg('closing', 'closing', quiet ? 'Sign-off' : 'Takeaways', closingText(stories, input.edition, quiet), lex));
  return out;
}

export const buildScript: BuildScript = (input) => {
  const forms: StoryForm[] = input.stories.map((_, i) => (i === 0 ? 'full' : 'medium'));
  let segments = assemble(input, forms);
  const maxMinutes = input.editorial.targetMinutes.max;
  // Trim from the bottom of the running order: lower stories first, the lead last.
  const order = forms.map((_, i) => i).reverse();
  for (const step of ['short', 'lead'] as const) {
    for (const i of order) {
      if (estimateMinutes(segments) <= maxMinutes) return segments;
      if (step === 'short' && i > 0 && forms[i] !== 'short') forms[i] = 'short';
      else if (step === 'lead' && i === 0 && forms[0] === 'full') forms[0] = 'medium';
      else continue;
      segments = assemble(input, forms);
    }
  }
  return segments;
};

