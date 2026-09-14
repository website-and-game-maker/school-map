// Feedback, taken in literally as a prompt.
//
// The usual shape of a feedback box is: the user types a sentence, it lands in
// a database, and somebody eventually reads it and translates it into work.
// This app has no database and no server, and — more to the point — the work
// that feedback turns into is nearly always "change a number in
// src/data/floors/*.json and open a pull request". That is a job you can hand
// to a coding agent verbatim.
//
// So the feedback box does not produce a ticket. It produces a PROMPT: the
// sentence the editor typed, wrapped in exactly the context needed to act on it
// without a conversation — which floor was open, where the map was pointed,
// which point was selected, what route was being shown, what the underlying
// data says at that spot. Paste it into Claude Code at the repo root and the
// change can be made and reviewed on the spot.
//
// Two things this is careful about:
//
//   * The editor's words are quoted VERBATIM and fenced, never paraphrased into
//     an instruction. A prompt that rewrites what somebody said is a prompt that
//     acts on something they did not ask for. Everything the app adds is
//     labelled as context, so the reader can always tell the report from the
//     machine's notes about it.
//   * The context is facts the app already has on screen. It does not sweep up
//     anything about who is using it.

import type { FloorData, FloorId, FloorPoint } from "../types";
import { FLOOR_LABELS } from "./directions";

export interface FeedbackContext {
  floorId: FloorId;
  floor: FloorData;
  /** What the user was routing, if anything. */
  from: string | null;
  to: string | null;
  /** The point selected in edit mode, if any. */
  selectedId: string | null;
  /** Where the map was pointed, in plan pixels, if known. */
  lookingAt: [number, number] | null;
  view: "2d" | "3d";
}

export interface FeedbackPrompt {
  /** The whole thing, ready to paste into a coding agent. */
  text: string;
  /** A one-line summary, used as the issue title. */
  title: string;
}

const REPO = "website-and-game-maker/school-map";

function nearestPoints(
  floor: FloorData,
  at: [number, number] | null,
  limit = 6
): Array<[string, FloorPoint, number]> {
  if (!at) return [];
  const [x, y] = at;
  return Object.entries(floor.points)
    .map(([id, p]) => [id, p, Math.hypot(p.x - x, p.y - y)] as [string, FloorPoint, number])
    .sort((a, b) => a[2] - b[2])
    .slice(0, limit);
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0].trim();
  return line.length > 72 ? `${line.slice(0, 69)}…` : line || "Map feedback";
}

/**
 * Turn one piece of feedback into a prompt a coding agent can act on.
 *
 * The structure is deliberate: the report first and unaltered, then the facts,
 * then what "done" means. An agent that reads only the top of this still knows
 * what was asked.
 */
export function buildFeedbackPrompt(message: string, ctx: FeedbackContext): FeedbackPrompt {
  const said = message.trim();
  const near = nearestPoints(ctx.floor, ctx.lookingAt);

  const lines: string[] = [];
  lines.push("# Westlake Map — feedback from an editor");
  lines.push("");
  lines.push(
    "Someone using the map reported the following. Treat it as the task. It is quoted",
    "exactly as written — do not assume it means something more convenient.",
    ""
  );
  lines.push("```text");
  lines.push(said);
  lines.push("```");
  lines.push("");
  lines.push("## Where they were when they wrote it");
  lines.push("");
  lines.push(`- Floor open: **${FLOOR_LABELS[ctx.floorId]}** (\`src/data/floors/${ctx.floorId}.json\`)`);
  lines.push(`- View: ${ctx.view === "3d" ? "3D model" : "2D plan"}`);
  if (ctx.from || ctx.to) {
    lines.push(`- Route being shown: ${ctx.from ?? "—"} → ${ctx.to ?? "—"}`);
  } else {
    lines.push("- No route was being shown.");
  }
  if (ctx.lookingAt) {
    lines.push(
      `- Centre of the map view, in plan pixels: \`${Math.round(ctx.lookingAt[0])}, ${Math.round(ctx.lookingAt[1])}\``
    );
  }
  if (ctx.selectedId) {
    const p = ctx.floor.points[ctx.selectedId];
    lines.push(
      `- Point selected: \`${ctx.selectedId}\`` +
        (p ? ` — ${p.kind}${p.label ? ` "${p.label}"` : ""} at ${Math.round(p.x)},${Math.round(p.y)}` : "")
    );
  }
  if (near.length) {
    lines.push("");
    lines.push("Nearest traced points to that spot, closest first:");
    lines.push("");
    for (const [id, p, d] of near) {
      lines.push(
        `- \`${id}\` — ${p.kind}${p.label ? ` "${p.label}"` : ""} at ${Math.round(p.x)},${Math.round(p.y)} (${Math.round(d)} px away)`
      );
    }
  }
  lines.push("");
  lines.push("## What you need to know to act on it");
  lines.push("");
  lines.push(
    "- Room positions live in `src/data/floors/{lower,main,upper}.json` under `points`.",
    "  Coordinates are plan pixels on that floor's scan, origin top-left.",
    "- `tools/read_plan.py` reads the room numbers straight off the scan and reports",
    "  where the shipped data and the drawing disagree. Run it before moving a room by",
    "  hand — if the scan disagrees with the data, the scan is usually right.",
    "- Distances come from `PX_PER_FOOT` in `src/lib/directions.ts`. That is the only",
    "  scale constant; correct it there and nowhere else.",
    "- Stairwells and restrooms are not drawn on the plans at all. They are marked by",
    "  hand in the app's edit mode and stored as `poi` points.",
    "- Storey alignment for the 3D view is `src/data/floors/align3d.json`, and every",
    "  non-reference floor in it is `\"verified\": false`. It is not ground truth.",
    ""
  );
  lines.push("## Done looks like");
  lines.push("");
  lines.push(
    "A change on a branch with a pull request, small enough to review by reading it.",
    "If the report is about a room being in the wrong place, verify against the scan",
    "before moving anything. If it cannot be verified, say so in the PR rather than",
    "guessing — an approximate map that knows it is approximate is more useful than",
    "one that quietly invents precision.",
    ""
  );

  return { text: lines.join("\n"), title: firstLine(said) };
}

/** A prefilled "new issue" link, which is the only "submit" a static site has. */
export function issueUrl(prompt: FeedbackPrompt): string {
  const u = new URL(`https://github.com/${REPO}/issues/new`);
  u.searchParams.set("title", prompt.title);
  u.searchParams.set("body", prompt.text);
  return u.toString();
}

export function downloadPrompt(prompt: FeedbackPrompt): void {
  const blob = new Blob([prompt.text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "map-feedback-prompt.md";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
