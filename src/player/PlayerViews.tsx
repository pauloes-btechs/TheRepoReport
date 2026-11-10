import { useEffect, useId, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { EditionReport } from '../../shared/schemas';
import { ChevronDown, ChevronUp, DownloadIcon, ForwardIcon, PlayIcon, StopIcon } from '../components/icons';
import { cx } from '../components/ui';
import { audioPathFor, siteUrl } from '../lib/data';
import { editionTitle, formatBytes, formatClock, formatDate, formatDuration } from '../lib/format';
import { usePlayer } from './PlayerContext';
import { ChapterList, PlayPauseButton, Scrubber, SpeechFallback, TransportControls } from './controls';

export function DownloadLink({ report, reportPath }: { report: EditionReport; reportPath: string }) {
  if (!report.audio.available) return null;
  const href = siteUrl(audioPathFor(reportPath, report.audio.file));
  const size = formatBytes(report.audio.bytes);
  return (
    <a
      href={href}
      download={`TheRepoReport-${report.key}.mp3`}
      className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
    >
      <DownloadIcon size={16} />
      Download MP3{size ? ` (${size})` : ''}
    </a>
  );
}

/** Full player for one edition, shown on its page. */
export function EditionPlayer({ report, reportPath }: { report: EditionReport; reportPath: string }) {
  const player = usePlayer();
  if (!report.audio.available) return <SpeechFallback report={report} reportPath={reportPath} />;
  const isCurrent = player.edition?.report.key === report.key;
  const chapter = isCurrent ? player.chapters[player.currentChapterIndex] : undefined;
  return (
    <section aria-label="Listen to this edition" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      {isCurrent ? (
        <div className="space-y-3">
          <p className="text-center text-sm text-ink-2" aria-live="polite">
            {chapter ? <>Now: <span className="font-semibold text-ink">{chapter.title}</span></> : 'Ready to play'}
          </p>
          <Scrubber />
          <TransportControls />
          {player.error && <p role="alert" className="text-center text-sm text-bad-fg">{player.error}</p>}
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => player.load(report, reportPath, { autoplay: true })}
            aria-label={`Play the ${editionTitle(report.edition)}`}
            className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-signal text-signal-ink hover:bg-signal-hover"
          >
            <PlayIcon size={28} />
          </button>
          <div>
            <p className="font-semibold text-ink">Play the {editionTitle(report.edition)}</p>
            <p className="text-sm text-ink-3">
              {formatDuration(report.audio.durationSec) ?? 'Audio'}
              {report.audio.voice ? `, read by Piper voice ${report.audio.voice}` : ''}
            </p>
          </div>
        </div>
      )}
      {report.audio.chapters.length > 0 && (
        <details className="group mt-4 border-t border-line pt-2" open>
          <summary className="flex items-center justify-between py-2 text-sm font-semibold text-ink">
            Chapters
            <ChevronDown size={18} className="transition-transform group-open:rotate-180" />
          </summary>
          <ChapterList report={report} reportPath={reportPath} />
        </details>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <DownloadLink report={report} reportPath={reportPath} />
      </div>
    </section>
  );
}

/** Sticky player that survives navigation. Collapsed by default; expands to full controls. */
export function PlayerBar() {
  const player = usePlayer();
  const panelId = useId();
  const expandRef = useRef<HTMLButtonElement>(null);
  const { edition, expanded, setExpanded } = player;

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false);
        expandRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, setExpanded]);

  if (!edition) return null;
  const { report, reportPath } = edition;
  const speechMode = !edition.audioUrl;
  if (speechMode && !player.speech.speaking) return null;

  const title = `${editionTitle(report.edition)}, ${formatDate(report.date, { month: 'short', day: 'numeric' })}`;
  const chapter = player.chapters[player.currentChapterIndex];
  const pct = player.duration > 0 ? Math.min(100, (player.currentTime / player.duration) * 100) : 0;

  return (
    <section
      aria-label="Audio player"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.25)] backdrop-blur supports-[backdrop-filter]:bg-surface/85"
    >
      {!speechMode && (
        <div className="h-0.5 bg-line" aria-hidden="true">
          <div className="h-full bg-signal" style={{ width: `${pct}%` }} />
        </div>
      )}
      {expanded && !speechMode && (
        <div id={panelId} className="mx-auto max-h-[70dvh] max-w-3xl overflow-y-auto px-4 pt-4 pb-2">
          <div className="space-y-3">
            <Scrubber />
            <TransportControls />
            {player.error && <p role="alert" className="text-center text-sm text-bad-fg">{player.error}</p>}
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <h2 className="mb-1 text-sm font-semibold text-ink">Chapters</h2>
            <ChapterList report={report} reportPath={reportPath} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 pb-2">
            <DownloadLink report={report} reportPath={reportPath} />
            <Link
              to={`/edition/${report.key}`}
              onClick={() => setExpanded(false)}
              className="inline-flex items-center rounded-full border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
            >
              Open edition page
            </Link>
          </div>
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
        {speechMode ? (
          <button
            type="button"
            onClick={player.stopSpeech}
            aria-label="Stop reading aloud"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-signal text-signal-ink hover:bg-signal-hover"
          >
            <StopIcon size={18} />
          </button>
        ) : (
          <PlayPauseButton size="sm" />
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm font-semibold text-ink">
            {(player.playing || player.speech.speaking) && <span className="on-air h-2 w-2 shrink-0 rounded-full bg-signal" aria-hidden="true" />}
            <Link to={`/edition/${report.key}`} className="truncate hover:underline">
              {title}
            </Link>
          </p>
          <p className="truncate text-xs text-ink-3" aria-live="off">
            {speechMode
              ? 'Reading aloud with your browser voice (fallback)'
              : `${chapter ? `${chapter.title}, ` : ''}${formatClock(player.currentTime)} of ${formatClock(player.duration)}`}
          </p>
        </div>
        {!speechMode && (
          <>
            <button
              type="button"
              onClick={() => player.skip(15)}
              aria-label="Forward 15 seconds"
              className="hidden h-10 w-10 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 sm:inline-flex"
            >
              <ForwardIcon size={22} />
            </button>
            <button
              ref={expandRef}
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              aria-controls={expanded ? panelId : undefined}
              aria-label={expanded ? 'Collapse player' : 'Expand player'}
              className={cx('inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2')}
            >
              {expanded ? <ChevronDown size={22} /> : <ChevronUp size={22} />}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
