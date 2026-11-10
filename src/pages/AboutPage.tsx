import { Link } from 'react-router-dom';
import { SITE_URL } from '../../shared/contracts';
import { BAND_LABELS, DIMENSION_LABELS, DIMENSION_KEYS, STATUS_LABELS, STATUS_ORDER } from '../../shared/schemas';
import { PodcastFeedCard } from './ArchivePage';

const STEPS: [string, string][] = [
  ['Collect', 'Reads new releases, merged and notable pull requests, security advisories and busy issues from each repository on the watchlist, picking up where the last run stopped.'],
  ['Group', 'Joins a pull request, the issue it fixes and the release that ships it into one story, so a change is told once and its status moves forward.'],
  ['Classify', 'Sets the status from GitHub facts only. Merged code is not called released, and released is not called deployed without explicit evidence.'],
  ['Score', 'Awards points for evidence in six dimensions. Each point records the signal that earned it. Star counts alone earn nothing.'],
  ['Explain', 'A small language model running on the build machine writes the headline and plain-English explanation from the evidence it is given.'],
  ['Check', 'A validator rejects any link, version, CVE or date that is not in the evidence, and any claim of a stronger status. Failing stories get a plain template instead.'],
  ['Narrate', 'An offline voice reads the script into an MP3 with chapters, then the site and podcast feed are published.'],
];

export function AboutPage() {
  return (
    <article className="max-w-3xl space-y-10">
      <header>
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-ink sm:text-5xl">How TheRepoReport works</h1>
        <p className="mt-4 font-serif text-lg leading-relaxed text-ink-2">
          A personal tech news desk for the open-source projects you follow. Three times a day it reads public GitHub activity, decides
          what matters, explains it for someone new to the field and reads it to you.
        </p>
      </header>

      <section aria-labelledby="how">
        <h2 id="how" className="font-serif text-2xl font-semibold text-ink">
          One run, start to finish
        </h2>
        <ol className="mt-4 space-y-4">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="flex gap-4">
              <span className="font-serif text-2xl leading-none font-semibold text-ink-3 tabular" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <h3 className="font-semibold text-ink">{title}</h3>
                <p className="mt-0.5 leading-relaxed text-ink-2">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="schedule" className="space-y-3">
        <h2 id="schedule" className="font-serif text-2xl font-semibold text-ink">
          Schedule and retention
        </h2>
        <p className="leading-relaxed text-ink-2">
          Editions run at 7:15 AM, 1:15 PM and 7:15 PM Eastern time, every day. Each covers everything since the last successful run, so a
          missed run is absorbed by the next one. Editions, their audio and their transcripts are kept for 7 days and then removed. On a
          quiet day the edition is short and says so; it never invents news to fill time.
        </p>
      </section>

      <section aria-labelledby="scoring" className="space-y-3">
        <h2 id="scoring" className="font-serif text-2xl font-semibold text-ink">
          Reading a story
        </h2>
        <p className="leading-relaxed text-ink-2">
          The impact score runs from 0 to 100 across {DIMENSION_KEYS.map((k) => DIMENSION_LABELS[k].toLowerCase()).join(', ')}. Bands:{' '}
          {Object.values(BAND_LABELS).join(', ')}. Open “Why this score” on any story to see every point and the evidence behind it.
        </p>
        <p className="leading-relaxed text-ink-2">
          Status follows the life of a change: {STATUS_ORDER.map((s) => STATUS_LABELS[s]).join(', then ')}. Confidence reflects how many
          independent GitHub sources agree.
        </p>
      </section>

      <section aria-labelledby="cost" className="space-y-3">
        <h2 id="cost" className="font-serif text-2xl font-semibold text-ink">
          What it costs: nothing
        </h2>
        <ul className="list-disc space-y-1 pl-5 leading-relaxed text-ink-2">
          <li>GitHub Actions runs the newsroom on free public-repository minutes.</li>
          <li>GitHub Pages hosts this site, the audio and the feed.</li>
          <li>Ollama runs an open model on the build machine; no paid AI service is called.</li>
          <li>Kokoro, an open speech model, reads the script aloud on the same machine. Piper is the backup voice.</li>
          <li>There is no server, database or account. Your settings on this page stay in your browser.</li>
        </ul>
      </section>

      <section aria-labelledby="podcast" className="space-y-3">
        <h2 id="podcast" className="font-serif text-2xl font-semibold text-ink">
          Listen as a podcast
        </h2>
        <p className="leading-relaxed text-ink-2">
          In your podcast app, choose the option to follow a show by URL and paste the feed address. New editions arrive three times a day.
          Episodes expire after seven days, so download any you want to keep.
        </p>
        <PodcastFeedCard />
      </section>

      <p className="text-sm text-ink-3">
        Site: <a href={SITE_URL} className="underline">{SITE_URL}</a>. Want to change what is covered? See{' '}
        <Link to="/settings" className="underline">
          Settings
        </Link>
        .
      </p>
    </article>
  );
}

export function NotFoundPage() {
  return (
    <section className="py-10">
      <h1 className="font-serif text-3xl font-semibold text-ink">This page does not exist</h1>
      <p className="mt-2 text-ink-2">
        <Link to="/" className="text-signal-text underline">
          Go to today's editions
        </Link>
      </p>
    </section>
  );
}
