import { DIMENSION_LABELS, type EditionReport, type EventKind, type ReportStory } from '../../shared/schemas';
import { topicLabels } from '../lib/editions';
import { formatTimestamp } from '../lib/format';
import type { Level } from '../lib/prefs';
import { usePlayer } from '../player/PlayerContext';
import { ChevronDown, PlayIcon, SpeakIcon } from './icons';
import { BAND_BAR, BandBadge, ConfidenceTag, ExternalLink, FallbackBadge, StatusPill, Tag, cx } from './ui';

const KIND_LABELS: Record<EventKind, string> = {
  release: 'Release',
  pull_request: 'Pull request',
  issue: 'Issue',
  advisory: 'Security advisory',
  discussion: 'Discussion',
};

export function storyAnchor(id: string): string {
  return `story-${id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

interface StoryCardProps {
  story: ReportStory;
  rank: number;
  level: Level;
  /** Needed for "Play this story"; omit to hide the button. */
  report?: EditionReport;
  reportPath?: string;
}

export function StoryCard({ story, rank, level, report, reportPath }: StoryCardProps) {
  const ex = story.explanation;
  const headingId = `${storyAnchor(story.id)}-title`;
  const showIntermediate = level !== 'beginner' && ex.intermediate.trim() !== '';
  const showTechnical = level === 'technical' && ex.technical.trim() !== '';
  const hiddenIntermediate = !showIntermediate && ex.intermediate.trim() !== '';
  const hiddenTechnical = !showTechnical && ex.technical.trim() !== '';

  return (
    <article id={storyAnchor(story.id)} aria-labelledby={headingId} className="scroll-mt-24 rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <span className="font-serif text-3xl leading-none font-semibold text-ink-3 tabular" aria-hidden="true">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-3">
            <a href={`https://github.com/${story.repo}`} target="_blank" rel="noreferrer noopener" className="font-medium text-ink-2 hover:underline">
              {story.repo}
              <span className="sr-only"> on GitHub (opens in a new tab)</span>
            </a>
            <time dateTime={story.updatedAt}>{formatTimestamp(story.updatedAt)}</time>
          </p>
          <h3 id={headingId} className="mt-1 font-serif text-xl leading-snug font-semibold text-balance text-ink sm:text-[1.375rem]">
            <span className="sr-only">Story {rank}: </span>
            {ex.headline}
          </h3>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <BandBadge total={story.score.total} band={story.score.band} />
            <StatusPill status={story.status} previous={story.previousStatus} />
            <ConfidenceTag confidence={story.score.confidence} />
            {ex.source === 'fallback' && <FallbackBadge />}
          </div>
          {topicLabels(story).length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Topics">
              {topicLabels(story).map((t) => (
                <li key={t}>
                  <Tag>{t}</Tag>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-5 space-y-4 text-[0.97rem] leading-relaxed text-ink-2">
        <p className="text-ink">{ex.whatHappened}</p>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Fact term="Before">{ex.previously}</Fact>
          <Fact term="What changed">{ex.whatChanged}</Fact>
          <Fact term="Why it matters" wide>
            {ex.whyItMatters}
          </Fact>
          {ex.nextConfirmed.trim() && <Fact term="What happens next">{ex.nextConfirmed}</Fact>}
          {ex.nextSpeculative.trim() && (
            <Fact term="Speculative:">
              <span className="italic">{ex.nextSpeculative}</span>
            </Fact>
          )}
        </dl>
        {ex.analogy.trim() && (
          <p className="rounded-xl bg-surface-2 px-4 py-3 text-ink-2">
            <span className="font-semibold text-ink">Think of it this way. </span>
            {ex.analogy}
          </p>
        )}
        {ex.glossary.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-ink">Terms used</h4>
            <dl className="mt-1 space-y-1 text-sm">
              {ex.glossary.map((g) => (
                <div key={g.term}>
                  <dt className="inline font-semibold text-ink">{g.term}: </dt>
                  <dd className="inline">{g.definition}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {showIntermediate && <LevelText title="In more depth">{ex.intermediate}</LevelText>}
        {showTechnical && <LevelText title="Technical notes">{ex.technical}</LevelText>}
      </div>

      <div className="mt-5 divide-y divide-line border-y border-line">
        {(hiddenIntermediate || hiddenTechnical) && (
          <Disclosure title="Technical details">
            <div className="space-y-3 text-sm leading-relaxed text-ink-2">
              {hiddenIntermediate && <LevelText title="In more depth">{ex.intermediate}</LevelText>}
              {hiddenTechnical && <LevelText title="Technical notes">{ex.technical}</LevelText>}
            </div>
          </Disclosure>
        )}
        <Disclosure title="Why this score">
          <ScoreBreakdownView story={story} />
        </Disclosure>
      </div>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-ink">Evidence on GitHub</h4>
          <ul className="mt-1 space-y-1 text-sm">
            {story.links.map((l) => (
              <li key={l.url} className="break-words">
                <span className="text-ink-3">{KIND_LABELS[l.kind]}: </span>
                <ExternalLink href={l.url}>{l.label}</ExternalLink>
              </li>
            ))}
            {!story.links.some((l) => l.url === story.statusEvidenceUrl) && (
              <li>
                <span className="text-ink-3">Status evidence: </span>
                <ExternalLink href={story.statusEvidenceUrl}>Why this is “{story.status.replace('_', ' ')}”</ExternalLink>
              </li>
            )}
          </ul>
        </div>
        {report && reportPath && <PlayStoryButton report={report} reportPath={reportPath} storyId={story.id} headline={ex.headline} />}
      </div>
      {ex.source === 'fallback' && ex.validationNotes.length > 0 && (
        <p className="mt-3 text-xs text-ink-3">Why the fallback was used: {ex.validationNotes.join(' ')}</p>
      )}
    </article>
  );
}

function Fact({ term, children, wide }: { term: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cx(wide && 'sm:col-span-2')}>
      <dt className="text-sm font-semibold text-ink">{term}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function LevelText({ title, children }: { title: string; children: string }) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-ink">{title}</h4>
      <p className="mt-0.5 whitespace-pre-line">{children}</p>
    </div>
  );
}

function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group">
      <summary className="flex items-center justify-between gap-2 py-3 text-sm font-semibold text-ink hover:text-signal-text">
        {title}
        <ChevronDown size={18} className="transition-transform group-open:rotate-180" />
      </summary>
      <div className="pb-4">{children}</div>
    </details>
  );
}

export function ScoreBreakdownView({ story }: { story: ReportStory }) {
  const { score } = story;
  return (
    <div className="space-y-4 text-sm">
      <p className="text-ink-2">
        Scored <strong className="text-ink tabular">{Math.round(score.total)} of 100</strong> from evidence alone; the language model never sets a score.
      </p>
      <ul className="space-y-3" aria-label="Score by dimension">
        {score.dimensions.map((d) => {
          const pct = d.max > 0 ? Math.min(100, (d.awarded / d.max) * 100) : 0;
          return (
            <li key={d.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-ink">{DIMENSION_LABELS[d.key]}</span>
                <span className="tabular text-ink-2">
                  {d.awarded} / {d.max}
                </span>
              </div>
              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
                role="img"
                aria-label={`${DIMENSION_LABELS[d.key]}: ${d.awarded} of ${d.max} points`}
              >
                <div className={cx('h-full rounded-full', BAND_BAR[score.band])} style={{ width: `${pct}%` }} />
              </div>
              {d.signals.length > 0 ? (
                <ul className="mt-1.5 space-y-0.5 text-ink-2">
                  {d.signals.map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="tabular shrink-0 text-ink-3">+{s.points}</span>
                      <span className="min-w-0 break-words">
                        {s.reason}
                        {s.evidenceUrl && (
                          <>
                            {' '}
                            <ExternalLink href={s.evidenceUrl}>evidence</ExternalLink>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-ink-3">No evidence for this dimension.</p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-ink-2">
        <span className="font-semibold text-ink">Confidence: </span>
        {score.confidenceReason}
      </p>
      {score.ranksAboveNext && (
        <p className="text-ink-2">
          <span className="font-semibold text-ink">Ranked above the next story because </span>
          {score.ranksAboveNext.replace(/^because\s+/i, '')}
        </p>
      )}
    </div>
  );
}

function PlayStoryButton({ report, reportPath, storyId, headline }: { report: EditionReport; reportPath: string; storyId: string; headline: string }) {
  const player = usePlayer();
  const hasChapter = report.audio.available && report.audio.chapters.some((c) => c.storyId === storyId);
  const hasSegment = report.transcript.some((s) => s.storyId === storyId);
  if (report.audio.available ? !hasChapter : !(hasSegment && player.speech.supported)) return null;
  return (
    <button
      type="button"
      onClick={() => player.playStory(report, reportPath, storyId)}
      aria-label={report.audio.available ? `Play this story: ${headline}` : `Read this story aloud with your browser's voice: ${headline}`}
      className="inline-flex shrink-0 items-center gap-2 self-start rounded-full border border-signal px-4 py-2 text-sm font-semibold text-signal-text hover:bg-signal-soft"
    >
      {report.audio.available ? <PlayIcon size={16} /> : <SpeakIcon size={16} />}
      {report.audio.available ? 'Play this story' : 'Read aloud'}
    </button>
  );
}
