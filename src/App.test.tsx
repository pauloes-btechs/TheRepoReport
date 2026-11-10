// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { clearReportCache } from './lib/data';
import { EVENING_FALLBACK, MORNING, QUIET, fixtureManifest, fixtureReport, mockFetch, siteRoutes } from './test/helpers';

function go(path: string) {
  window.location.hash = `#${path}`;
}

beforeEach(() => {
  localStorage.clear();
  clearReportCache();
  go('/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function serve(routes: Parameters<typeof mockFetch>[0]) {
  const fetchMock = vi.fn(mockFetch(routes));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const allReports = () => [fixtureReport(MORNING), fixtureReport(EVENING_FALLBACK), fixtureReport(QUIET)];

describe('app states', () => {
  it('shows the designed empty state with the schedule when no manifest exists', async () => {
    serve({});
    render(<App />);
    expect(await screen.findByRole('heading', { name: "The first edition hasn't been published yet" })).toBeInTheDocument();
    const schedule = screen.getByRole('list', { name: 'Daily schedule, Eastern time' });
    expect(schedule).toHaveTextContent('7:15 AM');
    expect(schedule).toHaveTextContent('1:15 PM');
    expect(schedule).toHaveTextContent('7:15 PM');
  });

  it('shows an error with retry when the manifest does not validate, and recovers', async () => {
    const bad = { ...fixtureManifest(), editions: 'nope' };
    let manifest: unknown = bad;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => mockFetch({ ...siteRoutes(fixtureManifest(), allReports()), 'data/manifest.json': { body: manifest } })(url)));
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The newsroom data could not be loaded');
    expect(alert).toHaveTextContent('does not match the format');
    manifest = fixtureManifest();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: /Ollama ships a fix/ })).toBeInTheDocument();
  });
});

describe('home', () => {
  it('renders the latest edition, slots, alerts, stories and recent repos', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T15:00:00Z')); // 10:00 AM Eastern
    serve(siteRoutes(fixtureManifest(), allReports()));
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: /Ollama ships a fix/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Listen to the Morning Edition' })).toBeInTheDocument();
    expect(screen.getByText(/Last successful update/)).toBeInTheDocument();

    const slots = screen.getByRole('region', { name: /Today, Tuesday, November 10/ });
    const states = [...slots.querySelectorAll('li[data-state]')].map((li) => li.getAttribute('data-state'));
    expect(states).toEqual(['published', 'upcoming', 'upcoming']);

    const alerts = screen.getAllByRole('region', { name: 'Security and release alerts' })[0]!;
    expect(within(alerts).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByRole('article')).toHaveLength(4);
    expect(screen.getByRole('region', { name: 'Recently active' })).toHaveTextContent('ollama/ollama');
  });

  it('opens an edition without audio and labels it', async () => {
    serve(siteRoutes(fixtureManifest(), allReports()));
    go(`/edition/${EVENING_FALLBACK}`);
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Evening Edition' })).toBeInTheDocument();
    expect(screen.getByText('Downloadable audio unavailable for this edition')).toBeInTheDocument();
    expect(screen.getAllByText('Fallback summarization').length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'How this edition was made' })).toHaveTextContent('Fallback template');
  });

  it('explains an expired edition', async () => {
    serve(siteRoutes(fixtureManifest(), allReports()));
    go('/edition/2026-10-01-morning');
    render(<App />);
    expect(await screen.findByRole('heading', { name: /is not in the archive/ })).toBeInTheDocument();
  });
});

describe('archive', () => {
  it('groups editions by date with audio and transcript links and the feed', async () => {
    serve(siteRoutes(fixtureManifest(), allReports()));
    go('/archive');
    render(<App />);
    const days = await screen.findAllByRole('heading', { level: 2, name: /day, November/ });
    expect(days.map((d) => d.textContent)).toEqual(['Tuesday, November 10', 'Monday, November 9']);
    expect(screen.getByText(/Editions are kept for 7 days/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Download audio for/ })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /Transcript of/ })).toHaveLength(3);
    expect(screen.getByText('No audio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy podcast feed address' })).toBeInTheDocument();
  });
});

describe('settings', () => {
  it('edits a draft, shows the diff and validates weights', async () => {
    serve(siteRoutes(fixtureManifest(), allReports()));
    go('/settings');
    render(<App />);
    expect(screen.getByText('Drafts are stored only in this browser and change nothing until committed to the repository.')).toBeInTheDocument();
    const add = await screen.findByLabelText('Add a repository');
    expect(screen.getAllByText('Same as deployed.')).toHaveLength(2);

    fireEvent.change(add, { target: { value: 'not a repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Include both the owner');

    fireEvent.change(add, { target: { value: 'https://github.com/golang/go' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const watchlistChanges = screen.getByRole('list', { name: 'Changes to watchlist.json' });
    expect(watchlistChanges).toHaveTextContent('Added');
    expect(watchlistChanges).toHaveTextContent('repos.golang/go');

    fireEvent.click(screen.getByRole('button', { name: 'Remove vexl-it/vexl' }));
    expect(watchlistChanges).toHaveTextContent('repos.vexl-it/vexl');

    fireEvent.change(screen.getByLabelText('Security and safety'), { target: { value: '30' } });
    expect(screen.getByText(/Total: 105 of 100/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download editorial.json' })).toBeDisabled();
    expect(screen.getByRole('list', { name: 'Changes to editorial.json' })).toHaveTextContent('weights.security');

    const editLink = screen.getAllByRole('link', { name: /Open in GitHub editor/ })[0]!;
    expect(editLink).toHaveAttribute('href', 'https://github.com/pauloes-btechs/TheRepoReport/edit/main/config/watchlist.json');
    expect(JSON.parse(localStorage.getItem('trr.configDraft')!).watchlist.repos.some((r: { repo: string }) => r.repo === 'golang/go')).toBe(true);
  });

  it('keeps device preferences in localStorage', async () => {
    serve({});
    go('/settings');
    render(<App />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(localStorage.getItem('trr.theme')).toBe('dark');
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
    expect(await screen.findByText(/published with the first edition/)).toBeInTheDocument();
  });
});

describe('repositories and about', () => {
  it('filters repositories and finds their stories in the archive', async () => {
    serve(siteRoutes(fixtureManifest(), allReports()));
    go('/repos');
    render(<App />);
    expect(await screen.findByText('Showing 14 of 14')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Bitcoin' } });
    expect(screen.getByText('Showing 3 of 14')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '3' } });
    expect(screen.getByText('Showing 1 of 14')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'local-inference' } });
    expect(screen.getByText('Showing 1 of 14')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show stories from the archive' }));
    expect(await screen.findByRole('link', { name: /Ollama ships a fix/ })).toHaveAttribute('href', `#/edition/${MORNING}`);
  });

  it('explains how the newsroom works', () => {
    serve({});
    go('/about');
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'How TheRepoReport works' })).toBeInTheDocument();
    expect(screen.getByText(/Episodes expire after seven days, so download/)).toBeInTheDocument();
  });
});
