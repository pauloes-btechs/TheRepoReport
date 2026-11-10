import { useId } from 'react';
import type { EditionReport } from '../../shared/schemas';
import { BackIcon, ForwardIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, RestartIcon, SpeakIcon, StopIcon } from '../components/icons';
import { cx } from '../components/ui';
import { formatClock } from '../lib/format';
import { SPEEDS } from '../lib/prefs';
import { usePlayer } from './PlayerContext';

const iconBtn =
  'inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent';

export function PlayPauseButton({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const player = usePlayer();
  const dims = size === 'lg' ? 'h-16 w-16' : size === 'md' ? 'h-12 w-12' : 'h-10 w-10';
  return (
    <button
      type="button"
      onClick={player.toggle}
      aria-label={player.playing ? 'Pause' : 'Play'}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-signal text-signal-ink hover:bg-signal-hover', dims)}
    >
      {player.playing ? <PauseIcon size={size === 'lg' ? 28 : 22} /> : <PlayIcon size={size === 'lg' ? 28 : 22} />}
    </button>
  );
}

export function TransportControls() {
  const player = usePlayer();
  const hasChapters = player.chapters.length > 0;
  return (
    <div className="flex items-center justify-center gap-1 sm:gap-2" role="group" aria-label="Playback controls">
      <button type="button" className={iconBtn} onClick={player.restart} aria-label="Restart from the beginning">
        <RestartIcon />
      </button>
      <button type="button" className={iconBtn} onClick={player.prevStory} disabled={!hasChapters} aria-label="Previous story">
        <PrevIcon />
      </button>
      <button type="button" className={iconBtn} onClick={() => player.skip(-15)} aria-label="Back 15 seconds">
        <BackIcon size={24} />
      </button>
      <PlayPauseButton size="lg" />
      <button type="button" className={iconBtn} onClick={() => player.skip(15)} aria-label="Forward 15 seconds">
        <ForwardIcon size={24} />
      </button>
      <button type="button" className={iconBtn} onClick={player.nextStory} disabled={!hasChapters} aria-label="Next story">
        <NextIcon />
      </button>
      <SpeedSelect compact />
    </div>
  );
}

export function SpeedSelect({ compact = false }: { compact?: boolean }) {
  const player = usePlayer();
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2">
      <label htmlFor={id} className={compact ? 'sr-only' : 'text-sm text-ink-2'}>
        Playback speed
      </label>
      <select
        id={id}
        value={String(player.rate)}
        onChange={(e) => player.setRate(Number(e.target.value))}
        className="h-9 rounded-full border border-line-strong bg-surface px-2.5 text-sm font-semibold text-ink tabular"
      >
        {SPEEDS.map((s) => (
          <option key={s} value={String(s)}>
            {s}×
          </option>
        ))}
      </select>
    </span>
  );
}

export function Scrubber() {
  const player = usePlayer();
  const max = player.duration > 0 ? player.duration : 0;
  const value = Math.min(player.currentTime, max || player.currentTime);
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div>
      <input
        type="range"
        className="scrubber"
        min={0}
        max={max || 1}
        step={1}
        value={value}
        disabled={max === 0}
        onChange={(e) => player.seek(Number(e.target.value))}
        aria-label="Seek"
        aria-valuetext={`${formatClock(value)} of ${formatClock(max)}`}
        style={{ ['--pct' as string]: `${pct}%` }}
      />
      <div className="flex justify-between text-xs text-ink-3 tabular">
        <span>{formatClock(value)}</span>
        <span>
          <span className="sr-only">Remaining </span>-{formatClock(Math.max(0, max - value))}
        </span>
      </div>
    </div>
  );
}

/** Chapters of the loaded edition, or of `report` (clicking loads it). */
export function ChapterList({ report, reportPath }: { report: EditionReport; reportPath: string }) {
  const player = usePlayer();
  const isCurrent = player.edition?.report.key === report.key;
  const chapters = [...report.audio.chapters].sort((a, b) => a.startSec - b.startSec);
  if (!chapters.length) return null;
  return (
    <ol className="space-y-0.5" aria-label="Chapters">
      {chapters.map((c, i) => {
        const active = isCurrent && player.currentChapterIndex === i;
        return (
          <li key={c.id}>
            <button
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => {
                if (!isCurrent) player.load(report, reportPath, { startAt: c.startSec, autoplay: true });
                else player.jumpToChapter(i);
              }}
              className={cx(
                'flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2',
                active ? 'bg-signal-soft text-ink' : 'text-ink-2',
              )}
            >
              <span className="w-12 shrink-0 text-ink-3 tabular">{formatClock(c.startSec)}</span>
              <span className={cx('min-w-0 flex-1', active && 'font-semibold')}>
                {c.title}
                {active && <span className="sr-only"> (now playing)</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Browser speech synthesis for editions without downloadable audio. */
export function SpeechFallback({ report, reportPath }: { report: EditionReport; reportPath: string }) {
  const player = usePlayer();
  const isCurrent = player.edition?.report.key === report.key;
  const speaking = isCurrent && player.speech.speaking;
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface p-4">
      <p className="font-semibold text-ink">Downloadable audio unavailable for this edition</p>
      {report.audio.unavailableReason && <p className="mt-1 text-sm text-ink-2">Reason: {report.audio.unavailableReason}</p>}
      {player.speech.supported ? (
        <>
          <p className="mt-2 text-sm text-ink-2">
            Fallback: your browser can read the transcript aloud with its own voice. This is not the edition's narration.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {speaking ? (
              <button
                type="button"
                onClick={player.stopSpeech}
                className="inline-flex items-center gap-2 rounded-full bg-signal px-4 py-2 text-sm font-semibold text-signal-ink hover:bg-signal-hover"
              >
                <StopIcon size={16} /> Stop reading
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  player.load(report, reportPath);
                  player.speakFrom(0);
                }}
                className="inline-flex items-center gap-2 rounded-full bg-signal px-4 py-2 text-sm font-semibold text-signal-ink hover:bg-signal-hover"
              >
                <SpeakIcon size={16} /> Read aloud with browser voice
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-ink-2">This browser cannot read aloud. The full transcript is below.</p>
      )}
    </div>
  );
}
