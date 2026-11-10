/**
 * Edition identity. An edition is derived from New York wall-clock time when a
 * run starts, never from which cron entry fired, so late or manual runs land in
 * the right slot.
 */
import { EDITIONS, type EditionName } from './schemas';

export const NEWSROOM_TIMEZONE = 'America/New_York';

/** Scheduled local start times, as minutes after midnight. */
export const EDITION_START_MINUTES: Record<EditionName, number> = {
  morning: 7 * 60 + 15,
  afternoon: 13 * 60 + 15,
  evening: 19 * 60 + 15,
};

export interface LocalClock {
  /** YYYY-MM-DD */
  date: string;
  minutes: number;
}

/** Wall-clock date and minutes-after-midnight in the newsroom timezone. */
export function newYorkClock(instant: Date): LocalClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NEWSROOM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface ResolvedEdition {
  key: string;
  date: string;
  edition: EditionName;
}

/**
 * The edition a run starting at `instant` belongs to: the most recent slot
 * whose start time has passed. Before 7:15 AM it is the previous day's evening
 * edition. A small tolerance absorbs schedulers that fire slightly early.
 */
export function resolveEdition(instant: Date, toleranceMinutes = 10): ResolvedEdition {
  const clock = newYorkClock(instant);
  const minutes = clock.minutes + toleranceMinutes;
  let edition: EditionName | undefined;
  for (const name of EDITIONS) {
    if (minutes >= EDITION_START_MINUTES[name]) edition = name;
  }
  if (edition) return { key: `${clock.date}-${edition}`, date: clock.date, edition };
  const date = previousDate(clock.date);
  return { key: `${date}-evening`, date, edition: 'evening' };
}

export function editionKey(date: string, edition: EditionName): string {
  return `${date}-${edition}`;
}

export function parseEditionKey(key: string): ResolvedEdition | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})-(morning|afternoon|evening)$/.exec(key);
  if (!match) return undefined;
  return { key, date: match[1]!, edition: match[2] as EditionName };
}

export const EDITION_TITLES: Record<EditionName, string> = {
  morning: 'Morning Edition',
  afternoon: 'Afternoon Edition',
  evening: 'Evening Edition',
};

export const EDITION_GREETINGS: Record<EditionName, string> = {
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
};

/** True when an edition dated `date` is older than `retentionDays` relative to `now`. */
export function isExpired(date: string, now: Date, retentionDays: number): boolean {
  const today = newYorkClock(now).date;
  const ageDays = Math.round(
    (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000,
  );
  return ageDays >= retentionDays;
}

/**
 * A voice setting may list narrators separated by "|" (e.g.
 * "kokoro:bm_george|af_heart"). Each edition is read by one narrator, rotating
 * through the list slot by slot, so consecutive editions always change voice:
 * with two narrators, morning A, afternoon B, evening A, next morning B, ...
 */
export function voiceForEdition(voice: string, key: string): string {
  const prefix = voice.startsWith('kokoro:') ? 'kokoro:' : '';
  const names = voice
    .slice(prefix.length)
    .split('|')
    .map((v) => v.trim())
    .filter(Boolean);
  if (names.length <= 1) return voice;
  const parsed = parseEditionKey(key);
  if (!parsed) return `${prefix}${names[0]}`;
  const day = Math.round(Date.parse(`${parsed.date}T12:00:00Z`) / 86_400_000);
  const slot = day * EDITIONS.length + EDITIONS.indexOf(parsed.edition);
  return `${prefix}${names[slot % names.length]}`;
}
