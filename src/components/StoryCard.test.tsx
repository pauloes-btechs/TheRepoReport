// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlayerProvider } from '../player/PlayerContext';
import { EVENING_FALLBACK, MORNING, fixtureReport } from '../test/helpers';
import { StoryList } from './EditionParts';
import { StoryCard } from './StoryCard';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function renderCard(key = MORNING, index = 0) {
  const report = fixtureReport(key);
  const story = report.stories[index]!;
  const path = `data/editions/${key}/report.json`;
  render(
    <PlayerProvider>
      <StoryCard story={story} rank={index + 1} level="beginner" report={report} reportPath={path} />
    </PlayerProvider>,
  );
  return { report, story, card: screen.getByRole('article') };
}

describe('StoryCard', () => {
  it('shows headline, repo, score band, status with previous status and confidence', () => {
    const { story, card } = renderCard();
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent(story.explanation.headline);
    expect(within(card).getByText('ollama/ollama')).toBeInTheDocument();
    expect(card).toHaveTextContent('76Major');
    expect(card).toHaveTextContent('Released');
    expect(within(card).getByText('previously Merged')).toBeInTheDocument();
    expect(within(card).getByText('High confidence')).toBeInTheDocument();
    expect(within(card).getByText('Speculative:')).toBeInTheDocument();
  });

  it('renders the score breakdown with every dimension, its signals and evidence links', () => {
    const { story, card } = renderCard();
    const breakdown = within(card).getByRole('list', { name: 'Score by dimension' });
    expect(within(breakdown).getAllByRole('listitem').filter((li) => li.parentElement === breakdown)).toHaveLength(6);
    expect(within(breakdown).getByRole('img', { name: 'Security and safety: 25 of 25 points' })).toBeInTheDocument();
    expect(within(breakdown).getByText(/Security advisory rated high severity/)).toBeInTheDocument();
    const evidence = within(breakdown).getAllByRole('link', { name: /evidence/ });
    expect(evidence[0]).toHaveAttribute('href', 'https://github.com/ollama/ollama/security/advisories/GHSA-7x2q-fixture');
    expect(card).toHaveTextContent(story.score.confidenceReason);
    expect(card).toHaveTextContent('Ranked above the next story because it carries a high-severity security fix');
  });

  it('lists GitHub evidence links that open in a new tab', () => {
    const { story, card } = renderCard();
    for (const link of story.links) {
      const a = within(card).getByRole('link', { name: new RegExp(link.label.replace(/[()]/g, '\\$&')) });
      expect(a).toHaveAttribute('href', link.url);
      expect(a).toHaveAttribute('target', '_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });

  it('offers "Play this story" when the story has a chapter', () => {
    const { card } = renderCard();
    expect(within(card).getByRole('button', { name: /Play this story/ })).toBeInTheDocument();
  });

  it('labels fallback summarization', () => {
    const { card } = renderCard(EVENING_FALLBACK);
    expect(within(card).getByText('Fallback summarization')).toBeInTheDocument();
    expect(card).toHaveTextContent('Why the fallback was used');
  });
});

describe('explanation level', () => {
  it('moves intermediate and technical text out of the collapsed details as the level rises', () => {
    const report = fixtureReport(MORNING);
    const lead = report.stories[0]!;
    render(
      <MemoryRouter>
        <PlayerProvider>
          <StoryList report={report} reportPath={`data/editions/${MORNING}/report.json`} />
        </PlayerProvider>
      </MemoryRouter>,
    );
    const inClosedDetails = (text: string) => !!screen.getByText(text).closest('details');

    // Beginner (default): both only inside "Technical details".
    expect(screen.getByRole('radio', { name: 'Beginner' })).toBeChecked();
    expect(inClosedDetails(lead.explanation.intermediate)).toBe(true);
    expect(inClosedDetails(lead.explanation.technical)).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'Intermediate' }));
    expect(inClosedDetails(lead.explanation.intermediate)).toBe(false);
    expect(inClosedDetails(lead.explanation.technical)).toBe(true);
    expect(localStorage.getItem('trr.level')).toBe('intermediate');

    fireEvent.click(screen.getByRole('radio', { name: 'Technical' }));
    expect(inClosedDetails(lead.explanation.intermediate)).toBe(false);
    expect(inClosedDetails(lead.explanation.technical)).toBe(false);

    // A story with no intermediate/technical text has no "Technical details" section.
    const last = screen.getAllByRole('article').at(-1)!;
    expect(within(last).queryByText('Technical details')).not.toBeInTheDocument();
  });

  it('hides stories below the device minimum score with a note', () => {
    localStorage.setItem('trr.minScore', '50');
    const report = fixtureReport(MORNING);
    render(
      <MemoryRouter>
        <PlayerProvider>
          <StoryList report={report} reportPath={`data/editions/${MORNING}/report.json`} />
        </PlayerProvider>
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText(/2 stories below your minimum score of 50 are hidden/)).toBeInTheDocument();
  });
});
