import { useEffect, useRef, useState } from 'react';
import type { EditionReport } from '../../shared/schemas';
import { cx } from '../components/ui';
import { formatClock } from '../lib/format';
import { chapterIndexForSegment, sortedChapters, usePlayer } from './PlayerContext';

/** After a manual scroll, wait this long before following the audio again. */
const USER_SCROLL_HOLD_MS = 8000;

export function TranscriptPanel({ report, reportPath }: { report: EditionReport; reportPath: string }) {
  const player = usePlayer();
  const isCurrent = player.edition?.report.key === report.key;
  const active = isCurrent ? player.activeSegmentIndex : -1;
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);
  const [following, setFollowing] = useState(true);
  const chapters = sortedChapters(report);
  const canPlay = report.audio.available || player.speech.supported;

  const markUserScroll = () => {
    userScrolledAt.current = Date.now();
    setFollowing(false);
  };

  useEffect(() => {
    if (active < 0) return;
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-segment="${active}"]`);
    if (!container || !target) return;
    if (!following && Date.now() - userScrolledAt.current < USER_SCROLL_HOLD_MS) return;
    if (!following) setFollowing(true);
    const top = target.offsetTop - container.offsetTop - 12;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (typeof container.scrollTo === 'function') container.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
    else container.scrollTop = top;
  }, [active, following]);

  if (report.transcript.length === 0) return <p className="text-ink-3">This edition has no transcript.</p>;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-sm text-ink-3">
          {isCurrent ? (following ? 'Following along with playback.' : 'Auto-scroll paused while you read.') : 'Select a passage to listen from there.'}
        </p>
        {isCurrent && !following && (
          <button
            type="button"
            onClick={() => {
              userScrolledAt.current = 0;
              setFollowing(true);
            }}
            className="rounded-full border border-line-strong px-3 py-1 text-sm font-medium text-ink hover:bg-surface-2"
          >
            Follow along
          </button>
        )}
      </div>
      <div
        ref={containerRef}
        tabIndex={0}
        role="region"
        aria-label="Transcript"
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onKeyDown={(e) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) markUserScroll();
        }}
        className="max-h-[32rem] space-y-1 overflow-y-auto rounded-2xl border border-line bg-surface p-2"
      >
        {report.transcript.map((seg, i) => {
          const ci = chapterIndexForSegment(report.transcript, chapters, i);
          const start = chapters[ci]?.startSec;
          const isActive = i === active;
          return (
            <div
              key={seg.id}
              data-segment={i}
              aria-current={isActive ? 'true' : undefined}
              className={cx('rounded-xl px-3 py-3 transition-colors', isActive ? 'bg-signal-soft' : '')}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className={cx('text-sm font-semibold', isActive ? 'text-signal-text' : 'text-ink')}>{seg.title}</h3>
                {canPlay && (report.audio.available ? start !== undefined : true) && (
                  <button
                    type="button"
                    onClick={() => player.playSegment(report, reportPath, i)}
                    className="shrink-0 rounded-md px-1.5 text-xs text-ink-3 tabular underline hover:text-ink"
                    aria-label={`Listen from “${seg.title}”`}
                  >
                    {report.audio.available && start !== undefined ? formatClock(start) : 'Read from here'}
                  </button>
                )}
              </div>
              <p className="mt-1 font-serif text-[1.02rem] leading-[1.7] whitespace-pre-line text-ink-2">{seg.text}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
