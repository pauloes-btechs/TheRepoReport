import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  DIMENSION_KEYS,
  DIMENSION_LABELS,
  EditorialConfig,
  WatchlistConfig,
  type Manifest,
  type WatchedRepo,
} from '../../shared/schemas';
import { TrashIcon } from '../components/icons';
import { LevelSelector } from '../components/Layout';
import { ErrorState, ExternalLink, PageSkeleton, Tag, cx } from '../components/ui';
import {
  GITHUB_EDIT_URLS,
  StarImportError,
  diffEditorial,
  diffWatchlist,
  importStarred,
  mergeRepos,
  newWatchedRepo,
  parseRepoInput,
  serializeConfig,
  splitTopics,
  validateEditorial,
  validateWatchlist,
  weightsTotal,
  type ConfigChange,
} from '../lib/config-draft';
import {
  PREF_KEYS,
  SPEEDS,
  readRaw,
  useLevelPref,
  useMinScorePref,
  useRatePref,
  useThemePref,
  writeRaw,
  type ThemePref,
} from '../lib/prefs';
import { useSiteData } from '../lib/site-data';
import { PRIORITY_LABELS } from './ReposPage';

const input = 'h-10 w-full rounded-lg border border-line-strong bg-paper px-3 text-sm text-ink placeholder:text-ink-3';
const button = 'inline-flex items-center justify-center gap-1.5 rounded-full border border-line-strong px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-2 disabled:opacity-50';
const primary = 'inline-flex items-center justify-center gap-1.5 rounded-full bg-signal px-4 py-2 text-sm font-semibold text-signal-ink hover:bg-signal-hover disabled:opacity-50';

export function SettingsPage() {
  return (
    <div className="space-y-12">
      <header>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="mt-2 max-w-prose text-ink-2">
          Two kinds of settings live here. Device settings change how this browser shows the newsroom. The production configuration
          decides what the newsroom covers, and it only changes when the files in the repository change.
        </p>
      </header>
      <DeviceSettings />
      <ProductionSettings />
    </div>
  );
}

// ───────────────────────── This device ─────────────────────────

function DeviceSettings() {
  const [theme, setTheme] = useThemePref();
  const [rate, setRate] = useRatePref();
  const [level, setLevel] = useLevelPref();
  const [minScore, setMinScore] = useMinScorePref();
  const speedId = useId();
  const minId = useId();

  return (
    <section aria-labelledby="device-settings" className="space-y-5">
      <div>
        <h2 id="device-settings" className="font-serif text-2xl font-semibold text-ink">
          This device
        </h2>
        <p className="mt-1 text-sm text-ink-3">Saved in this browser only.</p>
      </div>
      <div className="divide-y divide-line rounded-2xl border border-line bg-surface">
        <Row label="Theme">
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Theme</legend>
            {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
              <label
                key={t}
                className={cx(
                  'cursor-pointer rounded-full border px-3 py-1.5 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-signal',
                  theme === t ? 'border-ink bg-ink text-paper' : 'border-line-strong text-ink-2',
                )}
              >
                <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => setTheme(t)} className="sr-only" />
                {t === 'system' ? 'Match system' : t === 'light' ? 'Light' : 'Dark'}
              </label>
            ))}
          </fieldset>
        </Row>
        <Row label="Playback speed" htmlFor={speedId}>
          <select id={speedId} value={String(rate)} onChange={(e) => setRate(Number(e.target.value))} className="h-10 w-28 rounded-lg border border-line-strong bg-paper px-3 text-sm text-ink">
            {SPEEDS.map((s) => (
              <option key={s} value={String(s)}>
                {s}×
              </option>
            ))}
          </select>
        </Row>
        <Row label="Explanation level" hint="Beginner is always available. Intermediate and Technical add detail where the edition has it.">
          <LevelSelector value={level} onChange={setLevel} />
        </Row>
        <Row label="Minimum score to show" htmlFor={minId} hint="Hides lower-scored stories on this device. The edition itself does not change.">
          <div className="flex items-center gap-3">
            <input
              id={minId}
              type="range"
              min={0}
              max={100}
              step={5}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
              className="w-48 accent-[var(--signal)]"
              aria-valuetext={minScore === 0 ? 'Show all stories' : `Hide stories below ${minScore}`}
            />
            <span className="w-24 text-sm text-ink tabular">{minScore === 0 ? 'Show all' : `${minScore} and up`}</span>
          </div>
        </Row>
      </div>
      <button
        type="button"
        className={button}
        onClick={() => [PREF_KEYS.theme, PREF_KEYS.rate, PREF_KEYS.level, PREF_KEYS.minScore].forEach((k) => writeRaw(k, null))}
      >
        Reset device settings
      </button>
    </section>
  );
}

function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="sm:max-w-xs">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="font-medium text-ink">
            {label}
          </label>
        ) : (
          <p className="font-medium text-ink">{label}</p>
        )}
        {hint && <p className="mt-0.5 text-sm text-ink-3">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ───────────────────────── Production configuration ─────────────────────────

interface Draft {
  watchlist: WatchlistConfig;
  editorial: EditorialConfig;
}

function loadDraft(): Draft | null {
  const raw = readRaw(PREF_KEYS.draft);
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as { watchlist?: unknown; editorial?: unknown };
    const w = WatchlistConfig.safeParse(json.watchlist);
    const e = EditorialConfig.safeParse(json.editorial);
    // Drafts with invalid edits in progress are kept as long as their shape is intact.
    if (!w.success || !e.success) return null;
    return { watchlist: w.data, editorial: e.data };
  } catch {
    return null;
  }
}

function ProductionSettings() {
  const { state, reload } = useSiteData();
  return (
    <section aria-labelledby="production-settings" className="space-y-5">
      <div>
        <h2 id="production-settings" className="font-serif text-2xl font-semibold text-ink">
          Production configuration (draft)
        </h2>
        <p className="mt-1 text-sm text-ink-3">
          Edits <code>config/watchlist.json</code> and <code>config/editorial.json</code>.
        </p>
      </div>
      <div role="note" className="rounded-xl border border-warn-fg/40 bg-warn-bg px-4 py-3 text-sm text-warn-fg">
        <strong>Drafts are stored only in this browser and change nothing until committed to the repository.</strong> This page never asks for
        a GitHub token.
      </div>
      {state.status === 'loading' && <PageSkeleton label="Loading the deployed configuration" />}
      {state.status === 'error' && (
        <ErrorState title="The deployed configuration could not be loaded" message={state.error.message} onRetry={reload} />
      )}
      {state.status === 'missing' && (
        <p className="rounded-xl border border-line bg-surface p-4 text-ink-2">
          The deployed configuration is published with the first edition. Until then, edit the files directly:{' '}
          <ExternalLink href={GITHUB_EDIT_URLS.watchlist}>watchlist.json</ExternalLink> and{' '}
          <ExternalLink href={GITHUB_EDIT_URLS.editorial}>editorial.json</ExternalLink>.
        </p>
      )}
      {state.status === 'ready' && <ConfigEditor manifest={state.manifest} />}
    </section>
  );
}

export function ConfigEditor({ manifest }: { manifest: Manifest }) {
  const deployed = manifest.config;
  const [draft, setDraft] = useState<Draft>(() => loadDraft() ?? structuredClone(deployed));

  useEffect(() => {
    writeRaw(PREF_KEYS.draft, JSON.stringify(draft));
  }, [draft]);

  const watchlistChanges = useMemo(() => diffWatchlist(deployed.watchlist, draft.watchlist), [deployed, draft]);
  const editorialChanges = useMemo(() => diffEditorial(deployed.editorial, draft.editorial), [deployed, draft]);
  const watchlistErrors = validateWatchlist(draft.watchlist);
  const editorialErrors = validateEditorial(draft.editorial);

  const setWatchlist = (patch: Partial<WatchlistConfig>) => setDraft((d) => ({ ...d, watchlist: { ...d.watchlist, ...patch } }));
  const setEditorial = (patch: Partial<EditorialConfig>) => setDraft((d) => ({ ...d, editorial: { ...d.editorial, ...patch } }));
  const updateRepo = (repo: string, patch: Partial<WatchedRepo>) =>
    setWatchlist({ repos: draft.watchlist.repos.map((r) => (r.repo === repo ? { ...r, ...patch } : r)) });

  return (
    <div className="space-y-8">
      <WatchlistEditor
        watchlist={draft.watchlist}
        onChange={setWatchlist}
        onUpdateRepo={updateRepo}
        errors={watchlistErrors}
      />
      <EditorialEditor editorial={draft.editorial} onChange={setEditorial} errors={editorialErrors} />

      <section aria-labelledby="draft-review" className="space-y-4 rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h3 id="draft-review" className="font-serif text-xl font-semibold text-ink">
          Review and commit
        </h3>
        <ChangeList title="watchlist.json" changes={watchlistChanges} />
        <ChangeList title="editorial.json" changes={editorialChanges} />
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
          <li>Download the changed file.</li>
          <li>Open it in the GitHub editor, replace the contents and commit.</li>
          <li>The next scheduled edition uses the new configuration.</li>
        </ol>
        <div className="grid gap-4 sm:grid-cols-2">
          <FileActions
            name="watchlist.json"
            content={serializeConfig(draft.watchlist)}
            editUrl={GITHUB_EDIT_URLS.watchlist}
            changed={watchlistChanges.length > 0}
            errors={watchlistErrors}
          />
          <FileActions
            name="editorial.json"
            content={serializeConfig(draft.editorial)}
            editUrl={GITHUB_EDIT_URLS.editorial}
            changed={editorialChanges.length > 0}
            errors={editorialErrors}
          />
        </div>
        <button
          type="button"
          className={button}
          disabled={watchlistChanges.length + editorialChanges.length === 0}
          onClick={() => {
            if (window.confirm('Discard every change in this draft and start again from the deployed configuration?')) {
              setDraft(structuredClone(deployed));
            }
          }}
        >
          Discard draft
        </button>
      </section>
    </div>
  );
}

function ErrorList({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <ul role="alert" className="space-y-1 rounded-lg bg-bad-bg px-4 py-2 text-sm text-bad-fg">
      {errors.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  );
}

function WatchlistEditor({
  watchlist,
  onChange,
  onUpdateRepo,
  errors,
}: {
  watchlist: WatchlistConfig;
  onChange: (patch: Partial<WatchlistConfig>) => void;
  onUpdateRepo: (repo: string, patch: Partial<WatchedRepo>) => void;
  errors: string[];
}) {
  const ids = { repo: useId(), category: useId(), priority: useId(), user: useId(), max: useId(), starred: useId(), importUser: useId() };
  const [repoInput, setRepoInput] = useState('');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState<1 | 2 | 3>(2);
  const [addError, setAddError] = useState<string | null>(null);
  const [importUser, setImportUser] = useState(watchlist.githubUser ?? '');
  const [importState, setImportState] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; message?: string }>({ status: 'idle' });

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseRepoInput(repoInput);
    if (!parsed.ok) return setAddError(parsed.error);
    if (watchlist.repos.some((r) => r.repo.toLowerCase() === parsed.repo.toLowerCase())) {
      return setAddError(`${parsed.repo} is already on the watchlist.`);
    }
    onChange({ repos: [...watchlist.repos, newWatchedRepo(parsed.repo, { category: category.trim() || 'Uncategorized', priority })] });
    setRepoInput('');
    setAddError(null);
  };

  const runImport = async () => {
    setImportState({ status: 'loading' });
    try {
      const starred = await importStarred(importUser, watchlist.maxRepos);
      const { repos, added } = mergeRepos(watchlist.repos, starred);
      onChange({ repos });
      setImportState({
        status: 'done',
        message: `Found ${starred.length} public stars; added ${added} new ${added === 1 ? 'repository' : 'repositories'} to the draft.`,
      });
    } catch (err) {
      setImportState({ status: 'error', message: err instanceof StarImportError ? err.message : 'The import failed.' });
    }
  };

  return (
    <section aria-labelledby="watchlist-editor" className="space-y-4">
      <h3 id="watchlist-editor" className="font-serif text-xl font-semibold text-ink">
        Watchlist
      </h3>

      <form onSubmit={add} className="grid gap-3 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] sm:items-end">
        <div>
          <label htmlFor={ids.repo} className="text-sm font-medium text-ink-2">
            Add a repository
          </label>
          <input
            id={ids.repo}
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/name or https://github.com/owner/name"
            aria-invalid={!!addError}
            aria-describedby={addError ? `${ids.repo}-err` : undefined}
            className={cx(input, 'mt-1')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label htmlFor={ids.category} className="text-sm font-medium text-ink-2">
            Category
          </label>
          <input id={ids.category} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Uncategorized" className={cx(input, 'mt-1')} />
        </div>
        <div>
          <label htmlFor={ids.priority} className="text-sm font-medium text-ink-2">
            Priority
          </label>
          <select id={ids.priority} value={priority} onChange={(e) => setPriority(Number(e.target.value) as 1 | 2 | 3)} className={cx(input, 'mt-1')}>
            <option value={3}>High</option>
            <option value={2}>Normal</option>
            <option value={1}>Low</option>
          </select>
        </div>
        <button type="submit" className={primary}>
          Add
        </button>
        {addError && (
          <p id={`${ids.repo}-err`} role="alert" className="text-sm text-bad-fg sm:col-span-4">
            {addError}
          </p>
        )}
      </form>

      <ErrorList errors={errors} />

      <ul className="divide-y divide-line rounded-2xl border border-line bg-surface" aria-label="Repositories in the draft">
        {watchlist.repos.length === 0 && <li className="p-4 text-sm text-ink-3">The watchlist is empty.</li>}
        {watchlist.repos.map((r) => (
          <RepoRow key={r.repo} repo={r} onUpdate={(patch) => onUpdateRepo(r.repo, patch)} onRemove={() => onChange({ repos: watchlist.repos.filter((x) => x.repo !== r.repo) })} />
        ))}
      </ul>

      <div className="grid gap-4 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-3">
        <div>
          <label htmlFor={ids.user} className="text-sm font-medium text-ink-2">
            GitHub user for stars
          </label>
          <input
            id={ids.user}
            value={watchlist.githubUser ?? ''}
            onChange={(e) => onChange({ githubUser: e.target.value.trim() || undefined })}
            className={cx(input, 'mt-1')}
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label htmlFor={ids.max} className="text-sm font-medium text-ink-2">
            Maximum repositories
          </label>
          <input
            id={ids.max}
            type="number"
            min={1}
            value={watchlist.maxRepos}
            onChange={(e) => onChange({ maxRepos: Math.round(Number(e.target.value)) })}
            className={cx(input, 'mt-1 tabular')}
          />
        </div>
        <label htmlFor={ids.starred} className="flex items-center gap-2 self-end pb-2 text-sm font-medium text-ink">
          <input
            id={ids.starred}
            type="checkbox"
            checked={watchlist.includeStarred}
            onChange={(e) => onChange({ includeStarred: e.target.checked })}
            className="h-4 w-4 accent-[var(--signal)]"
          />
          Add public stars at run time
        </label>
      </div>

      <div className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <h4 className="font-semibold text-ink">Import public stars into the draft</h4>
        <p className="text-sm text-ink-2">
          Reads a user's public stars from GitHub without signing in, up to the maximum above. GitHub allows about 60 such requests an
          hour per network.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={ids.importUser} className="text-sm font-medium text-ink-2">
              GitHub username
            </label>
            <input
              id={ids.importUser}
              value={importUser}
              onChange={(e) => setImportUser(e.target.value)}
              className={cx(input, 'mt-1 w-56')}
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
          <button type="button" className={button} onClick={runImport} disabled={importState.status === 'loading' || !importUser.trim()}>
            {importState.status === 'loading' ? 'Importing…' : 'Import public stars'}
          </button>
        </div>
        <p aria-live="polite" className={cx('text-sm', importState.status === 'error' ? 'text-bad-fg' : 'text-ink-2')}>
          {importState.message}
        </p>
        <p className="text-sm text-ink-3">
          Repositories you <em>watch</em> can only be listed with a signed-in token, so that import runs on your computer:{' '}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 text-ink">npm run import:watched</code>, with <code>GITHUB_TOKEN</code> set in your
          shell.
        </p>
      </div>
    </section>
  );
}

function RepoRow({ repo: r, onUpdate, onRemove }: { repo: WatchedRepo; onUpdate: (patch: Partial<WatchedRepo>) => void; onRemove: () => void }) {
  const base = useId();
  const [topics, setTopics] = useState(r.topics.join(', '));
  useEffect(() => setTopics(r.topics.join(', ')), [r.topics]);
  return (
    <li className={cx('grid gap-3 p-4 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_7rem_minmax(0,1.2fr)_auto] sm:items-end', !r.enabled && 'bg-surface-2/50')}>
      <div className="min-w-0">
        <p className="truncate font-semibold text-ink">{r.repo}</p>
        <label className="mt-1 flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={r.enabled} onChange={(e) => onUpdate({ enabled: e.target.checked })} className="h-4 w-4 accent-[var(--signal)]" />
          {r.enabled ? 'Enabled' : <Tag tone="warn">Paused</Tag>}
          <span className="sr-only"> for {r.repo}</span>
        </label>
      </div>
      <div>
        <label htmlFor={`${base}-cat`} className="text-xs text-ink-3">
          Category
        </label>
        <input id={`${base}-cat`} value={r.category} onChange={(e) => onUpdate({ category: e.target.value })} className={cx(input, 'mt-0.5 h-9')} />
      </div>
      <div>
        <label htmlFor={`${base}-pri`} className="text-xs text-ink-3">
          Priority
        </label>
        <select id={`${base}-pri`} value={r.priority} onChange={(e) => onUpdate({ priority: Number(e.target.value) as 1 | 2 | 3 })} className={cx(input, 'mt-0.5 h-9')}>
          {([3, 2, 1] as const).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${base}-top`} className="text-xs text-ink-3">
          Topics, comma separated
        </label>
        <input
          id={`${base}-top`}
          value={topics}
          onChange={(e) => setTopics(e.target.value)}
          onBlur={() => onUpdate({ topics: splitTopics(topics) })}
          className={cx(input, 'mt-0.5 h-9')}
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${r.repo}`}
        className="inline-flex h-9 w-9 items-center justify-center justify-self-end rounded-full text-ink-3 hover:bg-bad-bg hover:text-bad-fg"
      >
        <TrashIcon size={18} />
      </button>
    </li>
  );
}

function EditorialEditor({ editorial, onChange, errors }: { editorial: EditorialConfig; onChange: (patch: Partial<EditorialConfig>) => void; errors: string[] }) {
  const base = useId();
  const total = weightsTotal(editorial.weights);
  const [topics, setTopics] = useState(editorial.topics.join(', '));
  useEffect(() => setTopics(editorial.topics.join(', ')), [editorial.topics]);
  const num = (v: string) => (v === '' ? Number.NaN : Number(v));

  return (
    <section aria-labelledby="editorial-editor" className="space-y-4">
      <h3 id="editorial-editor" className="font-serif text-xl font-semibold text-ink">
        Editorial settings
      </h3>
      <ErrorList errors={errors} />
      <div className="space-y-5 rounded-2xl border border-line bg-surface p-4">
        <div>
          <label htmlFor={`${base}-topics`} className="text-sm font-medium text-ink-2">
            Topics of interest, comma separated
          </label>
          <input
            id={`${base}-topics`}
            value={topics}
            onChange={(e) => setTopics(e.target.value)}
            onBlur={() => onChange({ topics: splitTopics(topics) })}
            className={cx(input, 'mt-1')}
          />
          <p className="mt-1 text-xs text-ink-3">Stories on these topics earn personal relevance points.</p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-ink-2">Maximum points per score dimension</legend>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {DIMENSION_KEYS.map((k) => (
              <div key={k}>
                <label htmlFor={`${base}-w-${k}`} className="text-xs text-ink-3">
                  {DIMENSION_LABELS[k]}
                </label>
                <input
                  id={`${base}-w-${k}`}
                  type="number"
                  min={0}
                  max={100}
                  value={Number.isNaN(editorial.weights[k]) ? '' : editorial.weights[k]}
                  onChange={(e) => onChange({ weights: { ...editorial.weights, [k]: num(e.target.value) } })}
                  className={cx(input, 'mt-0.5 tabular')}
                />
              </div>
            ))}
          </div>
          <p className={cx('mt-2 text-sm font-semibold tabular', total === 100 ? 'text-ok-fg' : 'text-bad-fg')} aria-live="polite">
            Total: {Number.isNaN(total) ? 'incomplete' : total} of 100{total === 100 ? '' : ' (must total exactly 100)'}
          </p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField label="Minimum score to report" value={editorial.minScore} onChange={(v) => onChange({ minScore: v })} min={0} max={100} />
          <NumberField label="Maximum stories per edition" value={editorial.maxStories} onChange={(v) => onChange({ maxStories: v })} min={1} />
          <NumberField label="Retention in days" value={editorial.retentionDays} onChange={(v) => onChange({ retentionDays: v })} min={1} />
          <NumberField
            label="Target length, minimum minutes"
            value={editorial.targetMinutes.min}
            onChange={(v) => onChange({ targetMinutes: { ...editorial.targetMinutes, min: v } })}
            min={1}
          />
          <NumberField
            label="Target length, maximum minutes"
            value={editorial.targetMinutes.max}
            onChange={(v) => onChange({ targetMinutes: { ...editorial.targetMinutes, max: v } })}
            min={1}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${base}-voice`} className="text-sm font-medium text-ink-2">
              Narrator voice
            </label>
            <input id={`${base}-voice`} value={editorial.voice} onChange={(e) => onChange({ voice: e.target.value })} className={cx(input, 'mt-1')} spellCheck={false} aria-describedby={`${base}-voice-help`} />
            <p id={`${base}-voice-help`} className="mt-1 text-xs text-ink-3">
              Kokoro: <code>kokoro:bm_george</code>, <code>kokoro:af_heart</code>, or <code>kokoro:bm_george|af_heart</code> to alternate narrators from one edition to the next. Piper: a voice name such as <code>en_US-ljspeech-high</code>.
            </p>
          </div>
          <div>
            <label htmlFor={`${base}-model`} className="text-sm font-medium text-ink-2">
              Ollama model
            </label>
            <input id={`${base}-model`} value={editorial.model} onChange={(e) => onChange({ model: e.target.value })} className={cx(input, 'mt-1')} spellCheck={false} />
          </div>
        </div>
      </div>
    </section>
  );
}

function NumberField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-ink-2">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        value={Number.isNaN(value) ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
        className={cx(input, 'mt-1 tabular')}
      />
    </div>
  );
}

function describe(value: unknown): string {
  if (value === undefined) return '(none)';
  if (typeof value === 'object' && value !== null && 'repo' in value) {
    const r = value as WatchedRepo;
    return `${r.repo} (${r.category}, ${PRIORITY_LABELS[r.priority]} priority${r.enabled ? '' : ', paused'})`;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function ChangeList({ title, changes }: { title: string; changes: ConfigChange[] }) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-ink">
        Changes to <code>{title}</code>
      </h4>
      {changes.length === 0 ? (
        <p className="mt-1 text-sm text-ink-3">Same as deployed.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm" aria-label={`Changes to ${title}`}>
          {changes.map((c, i) => (
            <li key={`${c.path}-${i}`} className="flex gap-2 break-words">
              <span
                className={cx(
                  'w-16 shrink-0 font-semibold',
                  c.kind === 'added' ? 'text-ok-fg' : c.kind === 'removed' ? 'text-bad-fg' : 'text-warn-fg',
                )}
              >
                {c.kind === 'added' ? 'Added' : c.kind === 'removed' ? 'Removed' : 'Changed'}
              </span>
              <span className="min-w-0 text-ink-2">
                <code className="text-ink">{c.path}</code>{' '}
                {c.kind === 'changed' && (
                  <>
                    from <span className="line-through decoration-1">{describe(c.before)}</span> to <strong className="text-ink">{describe(c.after)}</strong>
                  </>
                )}
                {c.kind === 'added' && <strong className="text-ink">{describe(c.after)}</strong>}
                {c.kind === 'removed' && <span className="line-through decoration-1">{describe(c.before)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileActions({ name, content, editUrl, changed, errors }: { name: string; content: string; editUrl: string; changed: boolean; errors: string[] }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="font-medium text-ink">
        <code>{name}</code> {changed ? <Tag tone="warn">Changed</Tag> : <Tag>Unchanged</Tag>}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={primary} onClick={download} disabled={errors.length > 0}>
          Download {name}
        </button>
        <a href={editUrl} target="_blank" rel="noreferrer noopener" className={button}>
          Open in GitHub editor
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
      {errors.length > 0 && <p className="mt-2 text-xs text-bad-fg">Fix the problems above before downloading.</p>}
    </div>
  );
}
