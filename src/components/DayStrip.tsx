import { Link } from 'react-router-dom';
import type { ManifestEdition } from '../../shared/schemas';
import { computeSlots, formatSlotTime, type EditionSlot } from '../lib/editions';
import { editionTitle, formatDate, pluralize } from '../lib/format';
import { cx } from './ui';

const START = 6 * 60;
const END = 22 * 60;
const pos = (minutes: number) => `${(Math.min(Math.max(minutes, START), END) - START) / (END - START) * 100}%`;

function SlotMarker({ slot }: { slot: EditionSlot }) {
  const base = 'absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2';
  const style = {
    published: 'border-signal bg-signal',
    upcoming: slot.due ? 'border-signal bg-surface' : 'border-line-strong bg-surface',
    missed: 'border-dashed border-ink-3 bg-paper',
  }[slot.state];
  return <span className={cx(base, style)} style={{ left: pos(slot.startMinutes) }} />;
}

function slotStatus(slot: EditionSlot): string {
  if (slot.state === 'published') return slot.entry?.quiet ? 'Published, quiet period' : `Published, ${pluralize(slot.entry?.storyCount ?? 0, 'story', 'stories')}`;
  if (slot.state === 'upcoming') return slot.due ? 'Publishing now' : 'Upcoming';
  return 'Missed, covered by the next edition';
}

/** Today's three editions on a day-long track, with a "now" needle. */
export function DayStrip({ editions, now }: { editions: ManifestEdition[]; now: Date }) {
  const { date, minutes, slots } = computeSlots(editions, now);
  const nowLabel = formatSlotTime(minutes);
  return (
    <section aria-labelledby="today-slots" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="today-slots" className="font-serif text-lg font-semibold text-ink">
          Today, {formatDate(date, { weekday: 'long', month: 'long', day: 'numeric' })}
        </h2>
        <p className="text-sm text-ink-3 tabular">Now {nowLabel} Eastern</p>
      </div>
      <div className="relative mx-2 mt-5 mb-1 h-6" aria-hidden="true">
        <div className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
        <div className="absolute top-1/2 left-0 h-0.5 -translate-y-1/2 bg-signal/60" style={{ width: pos(minutes) }} />
        {slots.map((s) => (
          <SlotMarker key={s.edition} slot={s} />
        ))}
        {minutes >= START && minutes <= END && (
          <span className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 rounded bg-ink" style={{ left: pos(minutes) }} />
        )}
      </div>
      <ol className="mt-3 grid gap-2 sm:grid-cols-3">
        {slots.map((slot) => {
          const body = (
            <>
              <span className="block font-serif text-xl font-semibold text-ink tabular">{formatSlotTime(slot.startMinutes)}</span>
              <span className="block text-sm font-medium text-ink-2">{editionTitle(slot.edition)}</span>
              <span
                className={cx(
                  'mt-1 block text-sm',
                  slot.state === 'published' ? 'text-signal-text' : slot.state === 'missed' ? 'text-ink-3' : 'text-ink-2',
                )}
              >
                {slotStatus(slot)}
              </span>
            </>
          );
          return (
            <li key={slot.edition} data-state={slot.state}>
              {slot.state === 'published' ? (
                <Link to={`/edition/${slot.key}`} className="block rounded-xl border border-line px-3 py-2.5 hover:border-signal hover:bg-signal-soft">
                  {body}
                </Link>
              ) : (
                <div className={cx('rounded-xl border px-3 py-2.5', slot.state === 'missed' ? 'border-dashed border-line-strong' : 'border-line')}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
