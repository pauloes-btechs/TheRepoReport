import { Link } from 'react-router-dom';
import type { Manifest } from '../../shared/schemas';
import { DownloadIcon, RssIcon } from '../components/icons';
import { ManifestGate } from '../components/Layout';
import { BandBadge, CopyButton, FallbackBadge, QuietBadge, Tag } from '../components/ui';
import { siteUrl } from '../lib/data';
import { groupByDate } from '../lib/editions';
import { editionTitle, formatDate, formatDuration, formatTimestamp, pluralize } from '../lib/format';
import { bandFor } from '../../shared/schemas';

export function feedUrl(): string {
  const path = siteUrl('feed.xml');
  return typeof window !== 'undefined' ? new URL(path, window.location.origin).toString() : path;
}

export function ArchivePage() {
  return <ManifestGate label="Loading the archive">{(manifest) => <ArchiveContent manifest={manifest} />}</ManifestGate>;
}

export function ArchiveContent({ manifest }: { manifest: Manifest }) {
  const days = groupByDate(manifest.editions);
  return (
    <div className="space-y-10">
      <header>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-ink">Archive</h1>
        <p className="mt-2 max-w-prose text-ink-2">
          Editions are kept for {manifest.retentionDays === 7 ? '7 days' : pluralize(manifest.retentionDays, 'day')}. Older editions, their audio and
          their transcripts are removed from the site and the podcast feed.
        </p>
      </header>

      <PodcastFeedCard />

      {days.length === 0 ? (
        <p className="text-ink-2">No editions are in the archive right now.</p>
      ) : (
        days.map((day) => (
          <section key={day.date} aria-labelledby={`day-${day.date}`}>
            <h2 id={`day-${day.date}`} className="border-b border-line pb-2 font-serif text-2xl font-semibold text-ink">
              {formatDate(day.date)}
            </h2>
            <ul className="divide-y divide-line">
              {day.editions.map((e) => (
                <li key={e.key} className="py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
                        <span className="font-semibold text-ink-2">{editionTitle(e.edition)}</span>
                        <span>{formatTimestamp(e.publishedAt)}</span>
                        {e.quiet && <QuietBadge />}
                        {e.summarization !== 'llm' && <FallbackBadge mixed={e.summarization === 'mixed'} />}
                      </p>
                      <Link to={`/edition/${e.key}`} className="mt-1 block font-serif text-xl leading-snug font-semibold text-ink hover:underline">
                        {e.topHeadline ?? (e.quiet ? 'A quiet period on the watchlist' : editionTitle(e.edition))}
                      </Link>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-3">
                        <span>{e.quiet ? 'No stories' : pluralize(e.storyCount, 'story', 'stories')}</span>
                        {formatDuration(e.durationSec) && <span>{formatDuration(e.durationSec)}</span>}
                        {e.topScore !== undefined && <BandBadge total={e.topScore} band={bandFor(e.topScore)} />}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {e.audioPath ? (
                        <a
                          href={siteUrl(e.audioPath)}
                          download={`TheRepoReport-${e.key}.mp3`}
                          className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
                          aria-label={`Download audio for the ${editionTitle(e.edition)}, ${formatDate(e.date, { month: 'long', day: 'numeric' })}`}
                        >
                          <DownloadIcon size={16} /> Audio
                        </a>
                      ) : (
                        <Tag>No audio</Tag>
                      )}
                      <Link
                        to={`/edition/${e.key}?section=transcript`}
                        className="inline-flex items-center rounded-full border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
                        aria-label={`Transcript of the ${editionTitle(e.edition)}, ${formatDate(e.date, { month: 'long', day: 'numeric' })}`}
                      >
                        Transcript
                      </Link>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

export function PodcastFeedCard() {
  const url = feedUrl();
  return (
    <section aria-labelledby="podcast-feed" className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 id="podcast-feed" className="flex items-center gap-2 font-serif text-lg font-semibold text-ink">
        <RssIcon size={18} /> Podcast feed
      </h2>
      <p className="mt-1 text-sm text-ink-2">
        Add this address to any podcast app that accepts a feed URL. Episodes expire after seven days, like the editions here.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a href={siteUrl('feed.xml')} className="min-w-0 rounded-lg bg-surface-2 px-3 py-1.5 text-sm break-all text-ink underline">
          {url}
        </a>
        <CopyButton text={url} label="Copy podcast feed address" />
      </div>
    </section>
  );
}
