import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EditionReport, Manifest, ManifestRepo } from '../../shared/schemas';
import { useNow } from '../components/EditionParts';
import { ManifestGate } from '../components/Layout';
import { storyAnchor } from '../components/StoryCard';
import { BandBadge, Tag, cx } from '../components/ui';
import { getReport } from '../lib/data';
import { editionTitle, formatDate, formatRelative, formatTimestamp, pluralize } from '../lib/format';

export const PRIORITY_LABELS: Record<1 | 2 | 3, string> = { 1: 'Low', 2: 'Normal', 3: 'High' };

export function ReposPage() {
  return <ManifestGate label="Loading repositories">{(manifest) => <ReposContent manifest={manifest} />}</ManifestGate>;
}

interface Filters {
  text: string;
  topic: string;
  category: string;
  priority: string;
}

export function filterRepos(repos: ManifestRepo[], f: Filters): ManifestRepo[] {
  const text = f.text.trim().toLowerCase();
  return repos.filter(
    (r) =>
      (!text || r.repo.toLowerCase().includes(text) || r.category.toLowerCase().includes(text) || r.topics.some((t) => t.toLowerCase().includes(text))) &&
      (!f.topic || r.topics.includes(f.topic)) &&
      (!f.category || r.category === f.category) &&
      (!f.priority || String(r.priority) === f.priority),
  );
}

interface FoundStory {
  headline: string;
  editionKey: string;
  editionLabel: string;
  storyId: string;
  total: number;
  band: EditionReport['stories'][number]['score']['band'];
}

/** Loads every archived report once, on request, to find stories per repository. */
function useStoryIndex(manifest: Manifest, enabled: boolean) {
  const [index, setIndex] = useState<Map<string, FoundStory[]> | null>(null);
  const [failed, setFailed] = useState(0);
  useEffect(() => {
    if (!enabled || index) return;
    let cancelled = false;
    Promise.allSettled(manifest.editions.map((e) => getReport(e.reportPath))).then((results) => {
      if (cancelled) return;
      const map = new Map<string, FoundStory[]>();
      let misses = 0;
      results.forEach((r) => {
        if (r.status !== 'fulfilled') {
          misses++;
          return;
        }
        const report = r.value;
        for (const s of report.stories) {
          const list = map.get(s.repo) ?? [];
          list.push({
            headline: s.explanation.headline,
            editionKey: report.key,
            editionLabel: `${editionTitle(report.edition)}, ${formatDate(report.date, { month: 'short', day: 'numeric' })}`,
            storyId: s.id,
            total: s.score.total,
            band: s.score.band,
          });
          map.set(s.repo, list);
        }
      });
      setFailed(misses);
      setIndex(map);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, index, manifest]);
  return { index, failed };
}

function ReposContent({ manifest }: { manifest: Manifest }) {
  const now = useNow(60_000);
  const [filters, setFilters] = useState<Filters>({ text: '', topic: '', category: '', priority: '' });
  const [showStories, setShowStories] = useState(false);
  const { index, failed } = useStoryIndex(manifest, showStories);
  const topics = useMemo(() => [...new Set(manifest.repos.flatMap((r) => r.topics))].sort(), [manifest]);
  const categories = useMemo(() => [...new Set(manifest.repos.map((r) => r.category))].sort(), [manifest]);
  const shown = filterRepos(manifest.repos, filters).sort(
    (a, b) => b.priority - a.priority || Date.parse(b.lastActivityAt ?? '0') - Date.parse(a.lastActivityAt ?? '0') || a.repo.localeCompare(b.repo),
  );
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-ink">Repositories</h1>
        <p className="mt-2 max-w-prose text-ink-2">
          The {pluralize(manifest.repos.length, 'repository', 'repositories')} the newsroom scans, from the watchlist in the repository and your public stars.
        </p>
      </header>

      <form role="search" aria-label="Filter repositories" className="grid gap-3 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => e.preventDefault()}>
        <Field label="Search">
          {(id) => (
            <input id={id} type="search" value={filters.text} onChange={(e) => set({ text: e.target.value })} placeholder="owner/name, category or topic" className={inputClass} />
          )}
        </Field>
        <Field label="Topic">
          {(id) => (
            <select id={id} value={filters.topic} onChange={(e) => set({ topic: e.target.value })} className={inputClass}>
              <option value="">All topics</option>
              {topics.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Category">
          {(id) => (
            <select id={id} value={filters.category} onChange={(e) => set({ category: e.target.value })} className={inputClass}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Priority">
          {(id) => (
            <select id={id} value={filters.priority} onChange={(e) => set({ priority: e.target.value })} className={inputClass}>
              <option value="">Any priority</option>
              <option value="3">High</option>
              <option value="2">Normal</option>
              <option value="1">Low</option>
            </select>
          )}
        </Field>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-3" aria-live="polite">
          Showing {shown.length} of {manifest.repos.length}
          {hasFilters && (
            <>
              {' '}
              <button type="button" className="ml-1 text-signal-text underline" onClick={() => setFilters({ text: '', topic: '', category: '', priority: '' })}>
                Clear filters
              </button>
            </>
          )}
        </p>
        {!showStories && (
          <button
            type="button"
            onClick={() => setShowStories(true)}
            className="rounded-full border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
          >
            Show stories from the archive
          </button>
        )}
        {showStories && !index && <p className="text-sm text-ink-3" role="status">Loading archived editions…</p>}
        {failed > 0 && <p className="text-sm text-bad-fg">{pluralize(failed, 'edition')} could not be loaded.</p>}
      </div>

      {shown.length === 0 ? (
        <p className="text-ink-2">No repositories match these filters.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {shown.map((r) => (
            <RepoCard key={r.repo} repo={r} now={now} stories={index?.get(r.repo)} />
          ))}
        </ul>
      )}
    </div>
  );
}

const inputClass = 'mt-1 h-10 w-full rounded-lg border border-line-strong bg-paper px-3 text-sm text-ink placeholder:text-ink-3';

function Field({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-ink-2">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

function RepoCard({ repo: r, now, stories }: { repo: ManifestRepo; now: Date; stories?: FoundStory[] }) {
  return (
    <li className={cx('rounded-2xl border border-line bg-surface p-4', !r.enabled && 'opacity-75')}>
      <div className="flex items-start justify-between gap-3">
        <a href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer noopener" className="min-w-0 font-semibold break-words text-ink hover:underline">
          {r.repo}
          <span className="sr-only"> (opens GitHub in a new tab)</span>
        </a>
        <span className="shrink-0 text-xs text-ink-3">{PRIORITY_LABELS[r.priority]} priority</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Tag tone="signal">{r.category}</Tag>
        <Tag>{r.source === 'starred' ? 'From your stars' : 'Watchlist'}</Tag>
        {!r.enabled && <Tag tone="warn">Paused</Tag>}
        {r.topics.map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-ink-3">Last activity</dt>
          <dd className="text-ink" title={formatTimestamp(r.lastActivityAt)}>
            {r.lastActivityAt ? formatRelative(r.lastActivityAt, now) : 'None recorded'}
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Last scanned</dt>
          <dd className="text-ink" title={formatTimestamp(r.lastScannedAt)}>
            {r.lastScannedAt ? formatRelative(r.lastScannedAt, now) : 'Not yet'}
          </dd>
        </div>
      </dl>
      <div className="mt-3 border-t border-line pt-2 text-sm">
        {stories === undefined ? (
          <p className="text-ink-3">{r.recentStoryIds.length ? `${pluralize(r.recentStoryIds.length, 'recent story', 'recent stories')}` : 'No recent stories'}</p>
        ) : stories.length === 0 ? (
          <p className="text-ink-3">No stories in the archive.</p>
        ) : (
          <ul className="space-y-1.5">
            {stories.map((s) => (
              <li key={`${s.editionKey}-${s.storyId}`}>
                <Link to={`/edition/${s.editionKey}`} state={{ story: storyAnchor(s.storyId) }} className="font-medium text-ink hover:underline">
                  {s.headline}
                </Link>
                <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                  {s.editionLabel} <BandBadge total={s.total} band={s.band} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
