// The sponsored card in the directions panel — how the map pays for itself
// while staying free to use, the way a phone map shows a promoted place.
//
// Sponsors are plain data in src/data/sponsors.json, so adding or removing one
// is a one-line PR, no code. A "house" entry is the map advertising the slot
// itself; any real sponsor takes priority over it.

import data from "../data/sponsors.json";

export interface Sponsor {
  id: string;
  name: string;
  text: string;
  url?: string;
  /** Destinations (search keys or labels) this card belongs next to. */
  near?: string[];
  /** The slot advertising itself; shown only when no real sponsor fits. */
  house?: boolean;
}

function isSponsor(x: unknown): x is Sponsor {
  const s = x as Partial<Sponsor>;
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.text === "string" &&
    (s.url === undefined || (typeof s.url === "string" && s.url.startsWith("https://")))
  );
}

export const SPONSORS: Sponsor[] = (data.sponsors as unknown[]).filter(isSponsor);

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * The card for a route ending at `dest`: a sponsor tied to that place first,
 * then any real sponsor, then the house card. Picked by a hash of the
 * destination so the same route always shows the same card.
 */
export function sponsorFor(
  dest: { key: string; label: string } | null,
  sponsors: Sponsor[] = SPONSORS
): Sponsor | null {
  if (!dest) return null;
  const here = sponsors.filter(
    (s) => !s.house && s.near?.some((n) => n === dest.key || n.toLowerCase() === dest.label.toLowerCase())
  );
  const real = sponsors.filter((s) => !s.house);
  const pool = here.length ? here : real.length ? real : sponsors;
  if (pool.length === 0) return null;
  return pool[hash(dest.key) % pool.length];
}
