// Edits leave the browser as a PROPOSAL, never as a change to the live map.
//
// The published map is whatever is committed on `main`. An editor working in a
// browser cannot reach that, and this module does not pretend otherwise: it
// packages what they changed into a file a reviewer can read, diff and merge.
// Until someone with write access does that, nothing anyone else sees moves.
//
// The file carries a plain-English summary next to the data, because the point
// of review is that a human can tell what they are accepting without reading a
// 400-line JSON diff.

import type { FloorData, FloorId, FloorPoint } from "../types";

export interface PointChange {
  kind: "added" | "removed" | "moved" | "renamed";
  id: string;
  detail: string;
}

export interface Proposal {
  kind: "westlake-map-proposal";
  version: 1;
  floor: FloorId;
  /** Filled in by the reviewer's tooling, not trusted from the browser. */
  submittedAt: string;
  summary: string[];
  data: FloorData;
}

const round = (n: number) => Math.round(n);

/** What changed between the shipped floor data and what the editor now has. */
export function diffFloor(base: FloorData, next: FloorData): PointChange[] {
  const out: PointChange[] = [];
  const describe = (p: FloorPoint) =>
    `${p.poiType ?? p.kind}${p.label ? ` "${p.label}"` : ""} at ${round(p.x)},${round(p.y)}`;

  for (const [id, p] of Object.entries(next.points)) {
    const before = base.points[id];
    if (!before) {
      out.push({ kind: "added", id, detail: `added ${describe(p)}` });
      continue;
    }
    if (round(before.x) !== round(p.x) || round(before.y) !== round(p.y)) {
      const dx = round(p.x) - round(before.x);
      const dy = round(p.y) - round(before.y);
      out.push({
        kind: "moved",
        id,
        detail: `moved ${before.label ?? id} by ${dx},${dy} px`,
      });
    }
    if ((before.label ?? "") !== (p.label ?? "")) {
      out.push({
        kind: "renamed",
        id,
        detail: `renamed ${before.label ?? id} to "${p.label ?? ""}"`,
      });
    }
  }
  for (const [id, p] of Object.entries(base.points)) {
    if (!next.points[id]) out.push({ kind: "removed", id, detail: `removed ${describe(p)}` });
  }
  return out;
}

export function buildProposal(floor: FloorId, base: FloorData, next: FloorData): Proposal {
  const changes = diffFloor(base, next);
  return {
    kind: "westlake-map-proposal",
    version: 1,
    floor,
    submittedAt: new Date().toISOString(),
    summary: changes.length
      ? changes.map((c) => c.detail)
      : ["no changes — this floor matches what is already published"],
    data: next,
  };
}

export function downloadProposal(p: Proposal): void {
  const blob = new Blob([JSON.stringify(p, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `proposal-${p.floor}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
