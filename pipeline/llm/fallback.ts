/**
 * Deterministic, source-grounded briefing used when the model is unavailable,
 * too slow, or produced text the validator rejected. Built only from event
 * fields, so it can never assert more than the evidence does. It runs itself
 * through the validator and, if a quoted title trips a check (for example a
 * hostile PR title), rebuilds with neutral references instead of titles.
 */
import {
  BAND_LABELS,
  DIMENSION_LABELS,
  STATUS_LABELS,
  type Explanation,
  type LlmExplanation,
  type RawEvent,
  type ScoredStory,
} from '../../shared/schemas';
import { eventDate, primaryEvent, repoName, sanitizeUntrusted, truncate } from './evidence';
import { isRoutine } from './prompt';
import { checkAgainstEvidence } from './validate';

const GLOSSARY: Record<string, string> = {
  release: 'A numbered, published version of a project that people can download and install.',
  'pull request': "A proposed change to a project's code that others review before deciding whether to accept it.",
  merged: "Accepted into the project's main code. It still has to be included in a release before most people can use it.",
  issue: "A public discussion thread used to report a problem or suggest an idea.",
  'security advisory': 'A public notice that describes a security flaw and how to fix it.',
  CVE: 'A public ID number given to a known security flaw so everyone can refer to the same problem.',
  'pre-release': 'A test version published before the final release so people can try it early.',
};

function kindNoun(e: RawEvent): string {
  switch (e.kind) {
    case 'pull_request':
      return 'pull request';
    case 'advisory':
      return 'security advisory';
    case 'release':
      return 'release';
    case 'issue':
      return 'issue';
    case 'discussion':
      return 'discussion';
  }
}

function cleanTitle(title: string): string {
  return truncate(
    sanitizeUntrusted(title)
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
      .replace(/["“”`]/g, "'")
      .replace(/\s+/g, ' ')
      .trim(),
    110,
  );
}

function ref(e: RawEvent, safe: boolean): string {
  const num = e.number !== undefined ? ` #${e.number}` : '';
  if (safe || !cleanTitle(e.title)) return `${kindNoun(e)}${num}`;
  return `"${cleanTitle(e.title)}"`;
}

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function build(story: ScoredStory, safe: boolean): LlmExplanation {
  const name = repoName(story.repo);
  const p = primaryEvent(story);
  const date = eventDate(p);
  const release = story.events.find((e) => e.kind === 'release');
  const advisory = story.events.find((e) => e.kind === 'advisory');
  const pr = story.events.find((e) => e.kind === 'pull_request');
  const severity = advisory?.severity ?? story.events.find((e) => e.severity)?.severity;
  const cve = advisory?.cveId ?? story.events.find((e) => e.cveId)?.cveId;
  const tag = release?.tagName ? cleanTitle(release.tagName) : undefined;
  const labels = [...new Set(story.events.flatMap((e) => e.labels))].map(cleanTitle).filter(Boolean).slice(0, 5);
  const status = STATUS_LABELS[story.status];
  const terms = new Set<string>();

  let headline: string;
  let whatHappened: string;
  let whatChanged: string;
  let nextConfirmed: string;
  let nextSpeculative: string;

  const securityLine = advisory
    ? ` It is linked to a security advisory${severity ? ` rated ${severity} severity` : ''}${cve ? ` (${cve})` : ''}.`
    : '';
  if (advisory) {
    terms.add('security advisory');
    if (cve) terms.add('CVE');
  }

  switch (story.status) {
    case 'released':
    case 'deployed': {
      terms.add('release');
      if (release?.prerelease) terms.add('pre-release');
      const what = tag ? `version ${tag}` : release ? 'a new release' : `an update (${ref(p, safe)})`;
      headline = advisory
        ? `${name} publishes ${tag ? `version ${tag}` : 'an update'} with a security fix`
        : tag
          ? `${name} publishes version ${tag}`
          : `${name}: ${ref(p, safe)}`;
      whatHappened = `The maintainers of ${name} published ${what} on ${date}.${securityLine}`;
      if (release && !safe && cleanTitle(release.title) && cleanTitle(release.title) !== tag) {
        whatHappened += ` The release is titled ${ref(release, false)}.`;
      }
      if (release?.prerelease) whatHappened += ' It is marked as a pre-release, which means a test version.';
      whatChanged =
        story.status === 'deployed'
          ? `The GitHub records mark this change as confirmed deployed. Status: ${status}.`
          : `${tag ? `Version ${tag}` : 'The new version'} is published on GitHub, so people can install it. Status: ${status}.`;
      nextConfirmed = advisory
        ? 'The security advisory on GitHub lists the details. No other next step has been announced.'
        : 'No next step has been announced.';
      nextSpeculative = '';
      break;
    }
    case 'merged': {
      terms.add('merged');
      if (pr) terms.add('pull request');
      headline = `${name} merges ${ref(pr ?? p, safe)}`;
      whatHappened = `A change in ${name}, ${ref(pr ?? p, safe)}, was merged on ${date}.${securityLine} This change has been merged into the main code but has not shipped in a release yet.`;
      whatChanged = `The change is now in the main code of ${name}, but people using published versions do not have it yet. Status: ${status}.`;
      nextConfirmed = 'No release date for this change has been announced.';
      nextSpeculative = 'It might be included in a future release.';
      break;
    }
    default: {
      const noun = kindNoun(p);
      terms.add(noun === 'issue' ? 'issue' : 'pull request');
      headline = `Proposal in ${name}: ${ref(p, safe)}`;
      whatHappened =
        story.status === 'in_development'
          ? `A change to ${name} is being worked on in an open ${noun}, ${ref(p, safe)}, opened on ${p.createdAt.slice(0, 10)}.${securityLine} It has not been accepted or merged.`
          : `Someone has proposed a change to ${name} in an open ${noun}, ${ref(p, safe)}, opened on ${p.createdAt.slice(0, 10)}.${securityLine} It has not been accepted or merged.`;
      whatChanged = `Nothing has changed in the project's code yet; this is only a proposal. Status: ${status}.`;
      nextConfirmed = 'No decision has been announced.';
      nextSpeculative = 'It could be changed, accepted, or closed after review.';
    }
  }

  const topDims = [...story.score.dimensions]
    .filter((d) => d.awarded > 0)
    .sort((a, b) => b.awarded - a.awarded)
    .slice(0, 2);
  const dimText = topDims
    .map((d) => {
      const reason = d.signals[0]?.reason;
      const label = DIMENSION_LABELS[d.key].toLowerCase();
      return safe || !reason ? label : `${label} (${cleanTitle(reason)})`;
    })
    .join(' and ');
  let whyItMatters = `TheRepoReport's scoring rated this story ${BAND_LABELS[story.score.band]}, ${story.score.total} out of 100${dimText ? `, mainly for ${dimText}` : ''}.`;
  if (advisory && (story.status === 'released' || story.status === 'deployed')) {
    whyItMatters += ' Anyone running an affected version should read the advisory and plan to upgrade.';
  } else if (story.status === 'merged') {
    whyItMatters += ' It matters to people who use this project once it reaches a published version.';
  } else if (story.status === 'proposed' || story.status === 'in_development') {
    whyItMatters += ' It is worth watching, but nothing has changed for users yet.';
  }

  const routine = isRoutine(story);
  const eventList = story.events
    .slice(0, 6)
    .map((e) => `${kindNoun(e)}${e.number !== undefined ? ` #${e.number}` : ''}${e.tagName && !safe ? ` (${cleanTitle(e.tagName)})` : ''}, ${e.state} ${eventDate(e)}`)
    .join('; ');
  const intermediate = routine ? '' : sentence(`This summary is built from ${story.events.length} GitHub record(s): ${eventList}`);
  const techBits = [
    `Status ${status} comes from ${kindNoun(p)}${p.number !== undefined ? ` #${p.number}` : ''}.`,
    labels.length && !safe ? `Labels: ${labels.join(', ')}.` : '',
    severity ? `Advisory severity: ${severity}.` : '',
    cve ? `Identifier: ${cve}.` : '',
  ].filter(Boolean);
  const technical = routine ? '' : techBits.join(' ');

  return {
    headline: truncate(headline, 140).padEnd(8, '.'),
    whatHappened: sentence(whatHappened),
    previously:
      'The GitHub records for this story do not describe how things worked before, so this automatic summary does not guess.',
    whatChanged: sentence(whatChanged),
    whyItMatters: sentence(whyItMatters),
    nextConfirmed,
    nextSpeculative,
    glossary: [...terms].slice(0, 6).map((term) => ({ term, definition: GLOSSARY[term] ?? '' })).filter((g) => g.definition),
    analogy: '',
    intermediate,
    technical,
  };
}

/** Deterministic explanation for one story. `reasons` explain why the fallback was used. */
export function fallbackExplanation(story: ScoredStory, reasons: string[]): Explanation {
  let value = build(story, false);
  let issues = checkAgainstEvidence(value, story);
  const notes = ['Deterministic template built only from GitHub event fields.', ...reasons];
  if (issues.length) {
    value = build(story, true);
    notes.push('Event titles were replaced with neutral references because they tripped the validator.');
    issues = checkAgainstEvidence(value, story);
    if (issues.length) notes.push(...issues.map((i) => `Fallback check: ${i}`));
  }
  return { ...value, source: 'fallback', validationNotes: notes };
}
