import { useEffect } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { parseEditionKey } from '../../shared/edition';
import type { Manifest } from '../../shared/schemas';
import { MetricsPanel, StoryList, WorthWatching } from '../components/EditionParts';
import { ManifestGate } from '../components/Layout';
import { ErrorState, FallbackBadge, PageSkeleton, QuietBadge, SectionHeading } from '../components/ui';
import { editionTitle, formatDate, formatTimestamp, pluralize } from '../lib/format';
import { useReport } from '../lib/site-data';
import { EditionPlayer } from '../player/PlayerViews';
import { TranscriptPanel } from '../player/TranscriptPanel';

export function EditionPage() {
  const { key = '' } = useParams();
  return <ManifestGate label="Loading the edition">{(manifest) => <EditionContent manifest={manifest} editionKey={key} />}</ManifestGate>;
}

function EditionContent({ manifest, editionKey }: { manifest: Manifest; editionKey: string }) {
  const entry = manifest.editions.find((e) => e.key === editionKey);
  const parsed = parseEditionKey(editionKey);
  const { state, retry } = useReport(entry?.reportPath);
  const [search] = useSearchParams();
  const jumpTo = search.get('section');
  const location = useLocation();
  const storyTarget = (location.state as { story?: string } | null)?.story;

  useEffect(() => {
    if (state.status !== 'ready' || !storyTarget) return;
    document.getElementById(storyTarget)?.scrollIntoView?.({ block: 'start' });
  }, [state.status, storyTarget]);

  useEffect(() => {
    if (state.status !== 'ready' || jumpTo !== 'transcript') return;
    document.getElementById('transcript')?.scrollIntoView?.({ block: 'start' });
  }, [state.status, jumpTo]);

  useEffect(() => {
    if (parsed) document.title = `${editionTitle(parsed.edition)}, ${formatDate(parsed.date, { month: 'short', day: 'numeric' })} | TheRepoReport`;
    return () => {
      document.title = 'TheRepoReport';
    };
  }, [parsed?.key]);

  if (!entry) {
    return (
      <section className="py-8">
        <h1 className="font-serif text-3xl font-semibold text-ink">
          {parsed ? `The ${editionTitle(parsed.edition)} for ${formatDate(parsed.date)} is not in the archive` : 'That edition does not exist'}
        </h1>
        <p className="mt-3 max-w-prose text-ink-2">
          Editions are kept for {manifest.retentionDays} days, and a scheduled run that found GitHub unreachable publishes nothing.
        </p>
        <Link to="/archive" className="mt-4 inline-block text-signal-text underline">
          Browse the archive
        </Link>
      </section>
    );
  }
  if (state.status === 'loading') return <PageSkeleton label="Loading the edition" />;
  if (state.status === 'error') return <ErrorState title="This edition could not be loaded" message={state.error.message} onRetry={retry} />;

  const report = state.report;
  return (
    <div className="space-y-10">
      <header>
        <p className="text-sm text-ink-3">
          <Link to="/archive" className="underline hover:text-ink">
            Archive
          </Link>
        </p>
        <h1 className="mt-2 font-serif text-4xl leading-tight font-semibold tracking-tight text-ink sm:text-5xl">{editionTitle(report.edition)}</h1>
        <p className="mt-2 text-lg text-ink-2">{formatDate(report.date)}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-3">
          <span>Published {formatTimestamp(entry.publishedAt)}</span>
          <span>{report.quiet ? 'Quiet period' : pluralize(report.stories.length, 'story', 'stories')}</span>
          {report.quiet && <QuietBadge />}
          {report.summarization !== 'llm' && <FallbackBadge mixed={report.summarization === 'mixed'} />}
        </div>
      </header>

      <div className="max-w-2xl">
        <EditionPlayer report={report} reportPath={entry.reportPath} />
      </div>

      <StoryList report={report} reportPath={entry.reportPath} />
      <WorthWatching report={report} />

      <section aria-labelledby="transcript-title">
        <div className="scroll-mt-24" id="transcript">
        <SectionHeading id="transcript-title" title="Transcript" note="The script as narrated, segment by segment." />
        </div>
        <TranscriptPanel report={report} reportPath={entry.reportPath} />
      </section>

      <MetricsPanel report={report} />
    </div>
  );
}
