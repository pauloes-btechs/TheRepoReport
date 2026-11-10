/**
 * Development status from API facts only. Merged never implies released, and
 * 'deployed' is never emitted: GitHub activity alone is not evidence that a
 * change is running anywhere.
 */
import { STATUS_ORDER, type DevStatus, type RawEvent, type StoryState } from '../../shared/schemas';
import { PATCHED_PREFIX } from '../collect/normalize';

const ACTIVE_PR_DAYS = 7;

export const statusRank = (s: DevStatus) => STATUS_ORDER.indexOf(s);

export interface StatusVerdict {
  status: DevStatus;
  evidenceUrl: string;
}

export function hasPatchedVersion(advisory: RawEvent): boolean {
  return advisory.body.startsWith(PATCHED_PREFIX);
}

/** Status a single event justifies on its own. */
function eventStatus(e: RawEvent, referenceTime: number): DevStatus {
  switch (e.kind) {
    case 'release':
      // A prerelease puts code in a tag but not in a stable release users get by default.
      return e.prerelease ? 'merged' : 'released';
    case 'advisory':
      return hasPatchedVersion(e) ? 'released' : 'proposed';
    case 'pull_request': {
      if (e.state === 'merged') return 'merged';
      const ageDays = (referenceTime - Date.parse(e.updatedAt)) / 86_400_000;
      return e.state === 'open' && !e.draft && ageDays <= ACTIVE_PR_DAYS ? 'in_development' : 'proposed';
    }
    default:
      return 'proposed';
  }
}

/**
 * `referenceTime` stands in for "now" (the newest event in the batch), which
 * keeps classification a pure function of its inputs.
 */
export function classify(events: RawEvent[], referenceTime: number, known?: StoryState): StatusVerdict {
  let best: { status: DevStatus; event: RawEvent } | undefined;
  for (const e of events) {
    const status = eventStatus(e, referenceTime);
    if (!best || isStrongerEvidence(status, e, best.status, best.event)) best = { status, event: e };
  }
  if (!best) throw new Error('classify needs at least one event');

  // Never regress below what an earlier edition established from evidence.
  if (known && statusRank(known.status) > statusRank(best.status)) {
    const url = evidenceUrlFromKnown(known);
    if (url) return { status: known.status, evidenceUrl: url };
  }
  return { status: best.status, evidenceUrl: best.event.url };
}

/** For equal status, the most direct proof wins (a release page over an advisory), then the newest. */
const EVIDENCE_PREFERENCE: RawEvent['kind'][] = ['release', 'advisory', 'pull_request', 'issue', 'discussion'];

function isStrongerEvidence(status: DevStatus, e: RawEvent, bestStatus: DevStatus, best: RawEvent): boolean {
  if (statusRank(status) !== statusRank(bestStatus)) return statusRank(status) > statusRank(bestStatus);
  const kindDelta = EVIDENCE_PREFERENCE.indexOf(e.kind) - EVIDENCE_PREFERENCE.indexOf(best.kind);
  if (kindDelta !== 0) return kindDelta < 0;
  return Date.parse(e.updatedAt) > Date.parse(best.updatedAt);
}

const KIND_FOR_STATUS: Record<DevStatus, string[]> = {
  deployed: [],
  released: ['release', 'advisory'],
  merged: ['pull_request', 'release'],
  in_development: ['pull_request'],
  proposed: ['pull_request', 'issue', 'advisory'],
};

function evidenceUrlFromKnown(known: StoryState): string | undefined {
  const kinds = KIND_FOR_STATUS[known.status];
  for (const kind of kinds) {
    const id = known.eventIds.find((eventId) => eventId.startsWith(`${kind}:`));
    const url = id ? urlForEventId(id) : undefined;
    if (url) return url;
  }
  return undefined;
}

/** Rebuilds the public GitHub URL for a stable event id. */
export function urlForEventId(id: string): string | undefined {
  let m = /^release:([^/:]+\/[^:]+):(.+)$/.exec(id);
  if (m) return `https://github.com/${m[1]}/releases/tag/${encodeURIComponent(m[2]!)}`;
  m = /^pull_request:([^#]+)#(\d+)$/.exec(id);
  if (m) return `https://github.com/${m[1]}/pull/${m[2]}`;
  m = /^issue:([^#]+)#(\d+)$/.exec(id);
  if (m) return `https://github.com/${m[1]}/issues/${m[2]}`;
  m = /^advisory:(GHSA-[\w-]+)$/i.exec(id);
  if (m) return `https://github.com/advisories/${m[1]}`;
  return undefined;
}
