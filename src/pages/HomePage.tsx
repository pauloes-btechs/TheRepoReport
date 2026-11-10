import { Link } from 'react-router-dom';
import type { EditionReport, Manifest, ManifestEdition } from '../../shared/schemas';
import { DayStrip } from '../components/DayStrip';
import { AlertsPanel, StoryList, TopHeadlines, WorthWatching, useNow } from '../components/EditionParts';
import { PauseIcon, PlayIcon } from '../components/icons';
import { ManifestGate } from '../components/Layout';
import { ErrorState, FallbackBadge, QuietBadge, SectionHeading, Skeleton } from '../components/ui';
import { editionTitle, formatDate, formatDuration, formatRelative, formatTimestamp, pluralize } from '../lib/format';
import { useReport } from '../lib/site-data';
import { usePlayer } from '../player/PlayerContext';
import { SpeechFallback } from '../player/controls';

export function HomePage() {
  return <ManifestGate>{(manifest) => <HomeContent manifest={manifest} />}</ManifestGate>;
}

function latestEdition(manifest: Manifest): ManifestEdition | undefined {
  return [...manifest.editions].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
}

function HomeContent({ manifest }: { manifest: Manifest }) {
  const now = useNow();
  const latest = latestEdition(manifest);
  const { state, retry } = useReport(latest?.reportPath);

  return (
    <div className="space-y-10">
      {latest ? (
        state.status === 'ready' ? (
          <Hero entry={latest} report={state.report} lastScan={manifest.lastSuccessfulScan} now={now} />
        ) : state.status === 'error' ? (
          <ErrorState title="The latest edition could not be loaded" message={state.error.message} onRetry={retry} />
        ) : (
          <HeroSkeleton />
        )
      ) : (
        <section className="py-6">
          <h1 className="font-serif text-4xl font-semibold tracking-tight text-ink">No editions in the last {manifest.retentionDays} days</h1>
          <p className="mt-3 max-w-prose text-ink-2">
            Editions are removed after {manifest.retentionDays} days. The next one will appear here after its scheduled run. Last successful
            scan: {formatTimestamp(manifest.lastSuccessfulScan)}.
          </p>
        </section>
      )}

      <DayStrip editions={manifest.editions} now={now} />

      {latest && state.status === 'ready' && (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-10">
            <TopHeadlines stories={state.report.stories} />
            <div className="lg:hidden">
              <AlertsPanel stories={state.report.stories} />
            </div>
            <StoryList report={state.report} reportPath={latest.reportPath} />
            <WorthWatching report={state.report} />
          </div>
          <aside className="space-y-6" aria-label="Alerts and activity">
            <div className="hidden lg:block">
              <AlertsPanel stories={state.report.stories} />
            </div>
            <RecentRepos manifest={manifest} now={now} />
          </aside>
        </div>
      )}
      {(!latest || state.status !== 'ready') && <RecentRepos manifest={manifest} now={now} />}
    </div>
  );
}

function Hero({ entry, report, lastScan, now }: { entry: ManifestEdition; report: EditionReport; lastScan: string; now: Date }) {
  const player = usePlayer();
  const isCurrent = player.edition?.report.key === report.key;
  const playing = isCurrent && player.playing;
  const lead = report.stories[0];
  const headline = lead?.explanation.headline ?? 'A quiet period on the watchlist';
  const dek = lead ? lead.explanation.whatHappened : 'Nothing on the watchlist cleared the reporting threshold in this window. The short edition says so instead of inventing news.';

  return (
    <section aria-labelledby="hero-title" className="pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2">
        <Link to={`/edition/${report.key}`} className="font-semibold text-ink hover:underline">
          {editionTitle(report.edition)}
        </Link>
        <span>{formatDate(report.date)}</span>
        <span className="text-ink-3">published {formatRelative(entry.publishedAt, now)}</span>
        {report.quiet && <QuietBadge />}
        {report.summarization !== 'llm' && <FallbackBadge mixed={report.summarization === 'mixed'} />}
      </div>
      <h1 id="hero-title" className="mt-3 max-w-4xl font-serif text-[2.1rem] leading-[1.1] font-semibold tracking-tight text-balance text-ink sm:text-5xl">
        {headline}
      </h1>
      <p className="mt-4 max-w-2xl font-serif text-lg leading-relaxed text-ink-2">{dek}</p>

      <div className="mt-6">
        {report.audio.available ? (
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => (isCurrent ? player.toggle() : player.load(report, entry.reportPath, { autoplay: true }))}
              className="inline-flex items-center gap-3 rounded-full bg-signal py-2 pr-6 pl-2 text-signal-ink hover:bg-signal-hover"
              aria-label={`${playing ? 'Pause the' : isCurrent ? 'Resume the' : 'Listen to the'} ${editionTitle(report.edition)}`}
            >
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-signal-ink/15">
                {playing ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
              </span>
              <span className="text-left">
                <span className="block text-base font-semibold">{playing ? 'Pause' : isCurrent ? 'Resume' : 'Listen'}</span>
                <span className="block text-sm opacity-85">{formatDuration(report.audio.durationSec) ?? 'Audio edition'}</span>
              </span>
            </button>
            <p className="text-sm text-ink-3">
              {report.quiet ? 'Short edition' : pluralize(report.stories.length, 'story', 'stories')}.{' '}
              <Link to={`/edition/${report.key}`} className="text-signal-text underline">
                Chapters and transcript
              </Link>
            </p>
          </div>
        ) : (
          <div className="max-w-xl">
            <SpeechFallback report={report} reportPath={entry.reportPath} />
          </div>
        )}
      </div>
      <p className="mt-5 text-sm text-ink-3">
        Last successful update: <time dateTime={lastScan}>{formatTimestamp(lastScan)}</time> ({formatRelative(lastScan, now)})
      </p>
    </section>
  );
}

function HeroSkeleton() {
  return (
    <div role="status" className="space-y-4 pt-2">
      <span className="sr-only">Loading the latest edition…</span>
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-12 w-full max-w-3xl" />
      <Skeleton className="h-12 w-2/3 max-w-2xl" />
      <Skeleton className="h-16 w-48 rounded-full" />
    </div>
  );
}

function RecentRepos({ manifest, now }: { manifest: Manifest; now: Date }) {
  const recent = manifest.repos
    .filter((r) => r.lastActivityAt)
    .sort((a, b) => Date.parse(b.lastActivityAt!) - Date.parse(a.lastActivityAt!))
    .slice(0, 8);
  return (
    <section aria-labelledby="recent-repos">
      <SectionHeading id="recent-repos" title="Recently active" />
      {recent.length === 0 ? (
        <p className="text-sm text-ink-3">No activity recorded yet.</p>
      ) : (
        <ul className="space-y-2">
          {recent.map((r) => (
            <li key={r.repo} className="flex items-baseline justify-between gap-3 text-sm">
              <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate font-medium text-ink hover:underline">
                {r.repo}
                <span className="sr-only"> (opens GitHub in a new tab)</span>
              </a>
              <time dateTime={r.lastActivityAt} className="shrink-0 text-ink-3">
                {formatRelative(r.lastActivityAt, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
      <Link to="/repos" className="mt-3 inline-block text-sm text-signal-text underline">
        All {manifest.repos.length} repositories
      </Link>
    </section>
  );
}
