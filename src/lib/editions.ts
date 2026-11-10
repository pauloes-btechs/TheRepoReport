import { EDITION_START_MINUTES, editionKey, newYorkClock } from '../../shared/edition';
import { EDITIONS, type EditionName, type ManifestEdition, type ReportStory } from '../../shared/schemas';

export type SlotState = 'published' | 'upcoming' | 'missed';

export interface EditionSlot {
  edition: EditionName;
  key: string;
  state: SlotState;
  /** Start time has passed but the run may still be in progress. */
  due: boolean;
  startMinutes: number;
  entry?: ManifestEdition;
}

/** How long after the scheduled start a slot still counts as "being published". */
export const PUBLISH_GRACE_MINUTES = 60;

export function formatSlotTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = String(minutes % 60).padStart(2, '0');
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export const SCHEDULE_TEXT = EDITIONS.map((e) => formatSlotTime(EDITION_START_MINUTES[e])).join(', ');

/** Today's three edition slots (New York date), from the manifest and the current time. */
export function computeSlots(
  editions: ManifestEdition[],
  now: Date,
  graceMinutes = PUBLISH_GRACE_MINUTES,
): { date: string; minutes: number; slots: EditionSlot[] } {
  const clock = newYorkClock(now);
  const byKey = new Map(editions.map((e) => [e.key, e]));
  const slots = EDITIONS.map((edition): EditionSlot => {
    const key = editionKey(clock.date, edition);
    const startMinutes = EDITION_START_MINUTES[edition];
    const entry = byKey.get(key);
    if (entry) return { edition, key, state: 'published', due: false, startMinutes, entry };
    if (clock.minutes < startMinutes) return { edition, key, state: 'upcoming', due: false, startMinutes };
    if (clock.minutes < startMinutes + graceMinutes) return { edition, key, state: 'upcoming', due: true, startMinutes };
    return { edition, key, state: 'missed', due: false, startMinutes };
  });
  return { date: clock.date, minutes: clock.minutes, slots };
}

/** Alerts: anything with a security signal, or a release that scored High or above. */
export function isAlert(story: ReportStory): boolean {
  const security = story.score.dimensions.find((d) => d.key === 'security');
  if (security && security.awarded > 0) return true;
  return story.status === 'released' && ['critical', 'major', 'high'].includes(story.score.band);
}

export function alertKind(story: ReportStory): 'security' | 'release' {
  const security = story.score.dimensions.find((d) => d.key === 'security');
  return security && security.awarded > 0 ? 'security' : 'release';
}

export interface ArchiveDay {
  date: string;
  editions: ManifestEdition[];
}

const EDITION_ORDER: Record<EditionName, number> = { morning: 0, afternoon: 1, evening: 2 };

/** Editions grouped by date, newest date first and newest edition first within a day. */
export function groupByDate(editions: ManifestEdition[]): ArchiveDay[] {
  const days = new Map<string, ManifestEdition[]>();
  for (const e of editions) {
    const list = days.get(e.date) ?? [];
    list.push(e);
    days.set(e.date, list);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, list]) => ({
      date,
      editions: list.sort((a, b) => EDITION_ORDER[b.edition] - EDITION_ORDER[a.edition]),
    }));
}

/** Topic labels for a story: its categories, de-duplicated. */
export function topicLabels(story: ReportStory): string[] {
  return [...new Set(story.categories.map((c) => c.trim()).filter(Boolean))];
}
