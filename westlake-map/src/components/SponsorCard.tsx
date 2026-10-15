// One clearly labelled sponsored card, under the directions. See lib/sponsors.ts.

import type { Sponsor } from "../lib/sponsors";

export default function SponsorCard({ sponsor }: { sponsor: Sponsor }) {
  const body = (
    <>
      <span className="sponsor-tag">Sponsored</span>
      <span className="sponsor-name">{sponsor.name}</span>
      <span className="sponsor-text">{sponsor.text}</span>
    </>
  );
  return sponsor.url ? (
    <a className="sponsor-card" href={sponsor.url} target="_blank" rel="noopener sponsored">
      {body}
    </a>
  ) : (
    <aside className="sponsor-card">{body}</aside>
  );
}
