/**
 * Picks the stories for an edition. A story already covered at its current
 * status has nothing new to say and is skipped; one whose status advanced
 * since coverage comes back.
 */
import type { SelectStories, Selection } from '../../shared/contracts';
import type { ScoredStory } from '../../shared/schemas';
import { statusRank } from '../stories/status';

const WATCH_MARGIN = 15;
const MAX_WATCHING = 4;
const WATCHABLE = new Set<ScoredStory['status']>(['proposed', 'in_development']);

export const selectStories: SelectStories = (scored, state, editorial) => {
  const selection: Selection = { selected: [], watching: [], skipped: [] };
  const watchFloor = editorial.minScore - WATCH_MARGIN;

  for (const story of scored) {
    const covered = state.stories[story.id]?.lastCoveredStatus;
    // "At or below" rather than "equal" so a status that somehow regressed is not re-reported.
    if (covered && statusRank(story.status) <= statusRank(covered)) {
      selection.skipped.push({ story, reason: `Already covered as ${covered}; no status change since.` });
      continue;
    }
    const { total } = story.score;
    if (total >= editorial.minScore && selection.selected.length < editorial.maxStories) {
      selection.selected.push(story);
      continue;
    }
    if (WATCHABLE.has(story.status) && total >= watchFloor && selection.watching.length < MAX_WATCHING) {
      selection.watching.push(story);
      continue;
    }
    selection.skipped.push({ story, reason: skipReason(story, editorial.minScore, editorial.maxStories) });
  }
  return selection;
};

function skipReason(story: ScoredStory, minScore: number, maxStories: number): string {
  if (story.score.total >= minScore) return `Scored ${story.score.total} but the edition is capped at ${maxStories} stories.`;
  return `Scored ${story.score.total}, below the ${minScore}-point threshold.`;
}
