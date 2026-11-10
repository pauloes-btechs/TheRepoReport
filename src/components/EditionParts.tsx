import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { STATUS_LABELS, type EditionReport, type ReportStory } from '../../shared/schemas';
import { alertKind, isAlert } from '../lib/editions';
import { formatDuration, formatTimestamp, pluralize } from '../lib/format';
import { useLevelPref, useMinScorePref } from '../lib/prefs';
import { ShieldIcon, TagIcon } from './icons';
import { LevelSelector } from './Layout';
import { StoryCard, storyAnchor } from './StoryCard';
import { BandBadge, ExternalLink, SectionHeading, StatusPill, cx } from './ui';

export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function StoryList({ report, reportPath, headingId = 'stories' }: { report: EditionReport; reportPath: string; headingId?: string }) {
  const [level, setLevel] = useLevelPref();
  const [minScore] = useMinScorePref();
  const visible = report.stories.filter((s) => s.score.total >= minScore);
  const hidden = report.stories.length - visible.length;
  return (
    <section aria-labelledby={headingId}>
      <SectionHeading id={headingId} title="The stories" note={report.stories.length ? 'Ranked by impact score, highest first.' : undefined}>
        {report.stories.length > 0 && <LevelSelector value={level} onChange={setLevel} />}
      </SectionHeading>
      {report.stories.length === 0 ? (
        <QuietNotice report={report} />
      ) : (
        <>
          {hidden > 0 && (
            <p className="mb-4 rounded-xl bg-surface-2 px-4 py-2 text-sm text-ink-2">
              {pluralize(hidden, 'story', 'stories')} below your minimum score of {minScore} {hidden === 1 ? 'is' : 'are'} hidden on this device.{' '}
              <Link to="/settings" className="text-signal-text underline">
                Change the filter
              </Link>
            </p>
          )}
          <ol className="space-y-5">
            {visible.map((story) => (
              <li key={story.id}>
                <StoryCard story={story} rank={report.stories.indexOf(story) + 1} level={level} report={report} reportPath={reportPath} />
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export function QuietNotice({ report }: { report: EditionReport }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <p className="font-serif text-lg font-semibold text-ink">A quiet period</p>
      <p className="mt-1 text-ink-2">
        Nothing on the watchlist cleared the reporting threshold between {formatTimestamp(report.windowStart)} and {formatTimestamp(report.windowEnd)}.
        No headlines were manufactured to fill the gap.
      </p>
    </div>
  );
}

export function TopHeadlines({ stories }: { stories: ReportStory[] }) {
  const top = stories.slice(0, 3);
  if (!top.length) return null;
  return (
    <section aria-labelledby="top-headlines">
      <SectionHeading id="top-headlines" title="Top headlines" />
      <ol className="divide-y divide-line">
        {top.map((s, i) => (
          <li key={s.id} className="flex gap-4 py-3">
            <span className="font-serif text-2xl leading-none font-semibold text-ink-3 tabular" aria-hidden="true">
              {i + 1}
            </span>
            <div className="min-w-0">
              <a href={`#${storyAnchor(s.id)}`} onClick={(e) => scrollToAnchor(e, storyAnchor(s.id))} className="font-serif text-lg leading-snug font-semibold text-ink hover:underline">
                {s.explanation.headline}
              </a>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-3">
                <span>{s.repo}</span>
                <BandBadge total={s.score.total} band={s.score.band} />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** HashRouter owns the URL hash, so in-page anchors scroll manually. */
export function scrollToAnchor(e: React.MouseEvent, id: string) {
  // Always prevent the default: the hash belongs to the router.
  e.preventDefault();
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  const heading = el.querySelector<HTMLElement>('h3');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
}

export function AlertsPanel({ stories }: { stories: ReportStory[] }) {
  const alerts = stories.filter(isAlert);
  if (!alerts.length) return null;
  return (
    <section aria-labelledby="alerts" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 id="alerts" className="font-serif text-lg font-semibold text-ink">
        Security and release alerts
      </h2>
      <ul className="mt-3 space-y-3">
        {alerts.map((s) => {
          const kind = alertKind(s);
          return (
            <li key={s.id} className="flex gap-3">
              <span
                className={cx(
                  'mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                  kind === 'security' ? 'bg-critical-bg text-critical-fg' : 'bg-notable-bg text-notable-fg',
                )}
              >
                {kind === 'security' ? <ShieldIcon size={17} /> : <TagIcon size={17} />}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-ink-3">{kind === 'security' ? 'Security' : 'Release'}</p>
                <a href={`#${storyAnchor(s.id)}`} onClick={(e) => scrollToAnchor(e, storyAnchor(s.id))} className="font-medium text-ink hover:underline">
                  {s.explanation.headline}
                </a>
                <p className="text-sm text-ink-3">
                  {s.repo}, {STATUS_LABELS[s.status].toLowerCase()}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function WorthWatching({ report }: { report: EditionReport }) {
  if (!report.worthWatching.length) return null;
  return (
    <section aria-labelledby="watching">
      <SectionHeading id="watching" title="Worth watching" note="Proposals and unresolved work that may become news." />
      <ul className="grid gap-3 sm:grid-cols-2">
        {report.worthWatching.map((w) => (
          <li key={w.url} className="rounded-2xl border border-line bg-surface p-4">
            <p className="text-sm text-ink-3">{w.repo}</p>
            <p className="mt-0.5 font-serif text-lg leading-snug font-semibold text-ink">{w.title}</p>
            <div className="mt-2">
              <StatusPill status={w.status} />
            </div>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">{w.note}</p>
            <p className="mt-2 text-sm">
              <ExternalLink href={w.url}>View on GitHub</ExternalLink>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MetricsPanel({ report }: { report: EditionReport }) {
  const m = report.metrics;
  const rows: [string, string | undefined][] = [
    ['Summarization', { llm: 'Language model', fallback: 'Fallback template', mixed: 'Mixed (model and fallback)' }[report.summarization]],
    ['Model', report.model],
    ['Reporting window', `${formatTimestamp(report.windowStart)} to ${formatTimestamp(report.windowEnd)}`],
    ['Generated', formatTimestamp(report.generatedAt)],
    ['Repositories scanned', m.reposScanned?.toString()],
    ['Events collected', m.eventsCollected?.toString()],
    ['Stories considered', m.storiesConsidered?.toString()],
    ['GitHub requests', m.githubRequests !== undefined ? `${m.githubRequests}${m.githubRateRemaining !== undefined ? ` (${m.githubRateRemaining} remaining)` : ''}` : undefined],
    ['Model load', m.modelLoadSeconds !== undefined ? `${m.modelLoadSeconds.toFixed(1)} s` : undefined],
    ['Inference time', m.inferenceSeconds !== undefined ? `${m.inferenceSeconds.toFixed(1)} s` : undefined],
    ['Tokens per second', m.tokensPerSecond?.toFixed(1)],
    ['Narration time', m.audioSeconds !== undefined ? `${m.audioSeconds.toFixed(1)} s` : undefined],
    ['Audio length', formatDuration(report.audio.durationSec)],
    ['Voice', report.audio.voice],
    ['Total run time', m.totalSeconds !== undefined ? formatDuration(m.totalSeconds) : undefined],
    ['Peak memory', m.peakMemoryMb !== undefined ? `${Math.round(m.peakMemoryMb)} MB` : undefined],
  ];
  return (
    <section aria-labelledby="how-made" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 id="how-made" className="font-serif text-lg font-semibold text-ink">
        How this edition was made
      </h2>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows
          .filter((r): r is [string, string] => !!r[1])
          .map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-line pb-1.5">
              <dt className="text-ink-3">{k}</dt>
              <dd className="text-right text-ink tabular">{v}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}
