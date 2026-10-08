// "My schedule": type your rooms in once, see every walk of the day.
//
// The panel owns the schedule and nothing else. Rooms are picked through the
// same SearchBox and index as From/To, a transition's time comes from the
// app's own router (handed in as `routeBetween`), and showing one on the map
// is just setting From and To — so the drawn route, the directions and the
// floor auto-selection are the ordinary ones, not a schedule-specific copy.

import { useEffect, useMemo, useState } from "react";
import SearchBox from "./SearchBox";
import { searchItems, type SearchItem } from "../lib/search";
import type { GridRoute } from "../lib/router";
import {
  PASSING_PERIOD_MINUTES,
  emptySchedule,
  loadSchedule,
  placeLabel,
  resolvePlace,
  saveSchedule,
  cachedSummarizer,
  transitionsFor,
  type Schedule,
  type ScheduleEntry,
  type Transition,
  type TransitionSummary,
} from "../lib/schedule";

interface Props {
  searchIndex: SearchItem[];
  floorLabel: (item: SearchItem) => string | null;
  /** The app's own From/To → route computation. Changes identity when the map data does. */
  routeBetween: (from: SearchItem, to: SearchItem) => GridRoute | null;
  /** Load a walk as the active route, exactly as if it had been searched. */
  onShow: (from: SearchItem, to: SearchItem) => void;
  /** Keys of the current From/To, to mark the walk being shown. */
  activeFrom: string | null;
  activeTo: string | null;
}

export default function SchedulePanel({
  searchIndex,
  floorLabel,
  routeBetween,
  onShow,
  activeFrom,
  activeTo,
}: Props) {
  // Read once: storage cannot change under us mid-visit except from another
  // tab, and following that is not worth a storage listener.
  const [schedule, setSchedule] = useState<Schedule | null>(() => loadSchedule());
  // Collapsed to one button until someone uses it; a returning student with a
  // saved schedule lands straight on their list of walks.
  const [open, setOpen] = useState(schedule !== null);
  const [editing, setEditing] = useState(schedule === null);

  useEffect(() => {
    if (schedule) saveSchedule(schedule);
  }, [schedule]);

  // The same default start the app itself uses: the Chap Court entrance.
  const defaultArrive = useMemo(() => {
    const c = searchIndex.find((i) => i.kind === "entrance" && i.label.startsWith("Chap Court"));
    return c ? { label: c.label, key: c.key } : null;
  }, [searchIndex]);

  function start() {
    // Reopening a schedule that was only hidden goes back to its walks; a
    // first open goes to the form.
    setEditing(!schedule || !schedule.periods.some((p) => p.room.trim()));
    setSchedule((s) => s ?? emptySchedule(defaultArrive));
    setOpen(true);
  }

  function forget() {
    saveSchedule(null);
    setSchedule(null);
    setOpen(false);
    setEditing(true);
  }

  const update = (fn: (s: Schedule) => Schedule) => setSchedule((s) => (s ? fn(s) : s));
  const setPeriod = (i: number, patch: Partial<ScheduleEntry>) =>
    update((s) => ({ ...s, periods: s.periods.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));

  const transitions = useMemo(
    () => (schedule ? transitionsFor(searchIndex, schedule) : []),
    [schedule, searchIndex]
  );

  // Routed once per pair of places per version of the map data, and not at
  // all until the list of walks is actually on screen. A walk costs ~40 ms
  // (~90 ms for the first, which also builds the stair-landing fields), so a
  // full day done in one go would freeze the panel for most of a second.
  // One walk per task instead: the list appears at once and fills in.
  const summarizeCached = useMemo(() => cachedSummarizer(routeBetween), [routeBetween]);
  const showList = open && !editing;
  const [timed, setTimed] = useState<{ of: Transition[]; done: TransitionSummary[] } | null>(null);
  useEffect(() => {
    if (!showList) return;
    const done: TransitionSummary[] = [];
    let timer = 0;
    const next = () => {
      done.push(summarizeCached(transitions[done.length]));
      setTimed({ of: transitions, done: [...done] });
      if (done.length < transitions.length) timer = window.setTimeout(next, 0);
    };
    if (transitions.length > 0) timer = window.setTimeout(next, 0);
    return () => window.clearTimeout(timer);
  }, [showList, transitions, summarizeCached]);
  // Only ever show times for the list they were computed for.
  const summaries: (TransitionSummary | undefined)[] = timed?.of === transitions ? timed.done : [];

  if (!open || !schedule) {
    return (
      <button className="sched-open" onClick={start}>
        <span className="sched-open-title">My schedule</span>
        <span className="sched-open-sub">Add your classes once — see every walk of the day</span>
      </button>
    );
  }

  const filled = schedule.periods.filter((p) => p.room.trim()).length;
  const anyTight = summaries.some((s) => s?.status === "ok" && s.tight);

  return (
    <section className="schedule" aria-label="My schedule">
      <div className="sched-head">
        <p className="sched-title">My schedule</p>
        <div className="sched-head-actions">
          {editing ? (
            <button className="sched-link" onClick={() => setEditing(false)} disabled={filled === 0}>
              Done
            </button>
          ) : (
            <button className="sched-link" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <button className="sched-link" onClick={() => setOpen(false)} aria-label="Hide schedule">
            Hide
          </button>
        </div>
      </div>

      {editing ? (
        <div className="sched-form">
          <RoomField
            label="Arrive from"
            placeholder="Entrance (optional)"
            text={schedule.arriveFrom?.label ?? ""}
            itemKey={schedule.arriveFrom?.key ?? null}
            searchIndex={searchIndex}
            floorLabel={floorLabel}
            onChange={(label, key) =>
              update((s) => ({ ...s, arriveFrom: label || key ? { label, key } : null }))
            }
          />
          {schedule.periods.map((p, i) => (
            <div className="sched-row" key={i}>
              <div className="field sched-name">
                <label htmlFor={`sched-name-${i}`}>Class</label>
                <input
                  id={`sched-name-${i}`}
                  value={p.name}
                  onChange={(e) => setPeriod(i, { name: e.target.value })}
                />
              </div>
              <RoomField
                label="Room"
                placeholder="e.g. 118"
                text={p.room}
                itemKey={p.key}
                searchIndex={searchIndex}
                floorLabel={floorLabel}
                onChange={(room, key) => setPeriod(i, { room, key })}
              />
              <button
                className="sched-remove"
                aria-label={`Remove ${p.name || "this class"}`}
                title="Remove"
                onClick={() => update((s) => ({ ...s, periods: s.periods.filter((_, j) => j !== i) }))}
              >
                ×
              </button>
            </div>
          ))}
          <div className="sched-form-actions">
            <button
              className="quick-chip"
              onClick={() =>
                update((s) => ({
                  ...s,
                  periods: [...s.periods, { name: `Period ${s.periods.length + 1}`, room: "", key: null }],
                }))
              }
            >
              + Add class
            </button>
            <button className="sched-link danger" onClick={forget}>
              Forget schedule
            </button>
          </div>
          <p className="tool-hint">Saved in this browser only. Leave a room blank for a free period.</p>
        </div>
      ) : transitions.length === 0 ? (
        <p className="hint">Add at least two classes, or a class and where you arrive, to see the walks.</p>
      ) : (
        <>
          <ol className="sched-trips">
            {transitions.map((t, i) => {
              const s = summaries[i];
              const usable = s?.status === "ok" && t.from && t.to;
              const active = Boolean(t.from && t.to && t.from.key === activeFrom && t.to.key === activeTo);
              const tight = s?.status === "ok" && s.tight;
              return (
                <li key={`${t.id}#${i}`}>
                  <button
                    className={`sched-trip${active ? " active" : ""}${tight ? " tight" : ""}`}
                    disabled={!usable}
                    onClick={() => t.from && t.to && onShow(t.from, t.to)}
                  >
                    <span className="sched-trip-names">
                      {t.fromName} <span className="route-arrow">→</span> {t.toName}
                    </span>
                    <span className="sched-trip-rooms">
                      {t.from ? placeLabel(t.from) : t.fromText} → {t.to ? placeLabel(t.to) : t.toText}
                    </span>
                    <span className="sched-trip-meta">{describe(s)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          {anyTight && (
            <p className="hint caution">
              Flagged walks take longer than a {PASSING_PERIOD_MINUTES}-minute passing period at a
              steady pace.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function describe(s: TransitionSummary | undefined): string {
  if (!s) return "Timing…";
  switch (s.status) {
    case "ok":
      return [
        `≈ ${s.minutes} min`,
        `${s.feet} ft`,
        s.flights > 0 ? `${s.flights} stair${s.flights > 1 ? "s" : ""}` : null,
        s.tight ? "tight" : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "same-room":
      return "Same room — no walk";
    case "unknown-room":
      return `Not on the map: ${s.which.join(", ")}`;
    case "no-route":
      return "No hallway reaches this yet";
  }
}

/**
 * A SearchBox bound to a stored (text, key) pair. A room only counts once it
 * has been picked or typed exactly; anything else is labelled here rather
 * than dropped, and shows up as a problem in the list of walks.
 */
function RoomField({
  label,
  placeholder,
  text,
  itemKey,
  searchIndex,
  floorLabel,
  onChange,
}: {
  label: string;
  placeholder: string;
  text: string;
  itemKey: string | null;
  searchIndex: SearchItem[];
  floorLabel: (item: SearchItem) => string | null;
  onChange: (text: string, key: string | null) => void;
}) {
  const resolved = useMemo(() => resolvePlace(searchIndex, text, itemKey), [searchIndex, text, itemKey]);
  const results = useMemo(
    () => (resolved && resolved.label === text ? [] : searchItems(searchIndex, text, { hasRestrooms: false, limit: 6 })),
    [searchIndex, text, resolved]
  );
  return (
    <div className={`sched-room${text.trim() && !resolved ? " unmatched" : ""}`}>
      <SearchBox
        label={label}
        placeholder={placeholder}
        value={text}
        results={results}
        floorLabel={floorLabel}
        // Typing a room's exact number counts as picking it, so the key is
        // stored the same either way and survives a reload without guessing.
        onQueryChange={(q) => onChange(q, resolvePlace(searchIndex, q, null)?.key ?? null)}
        onPick={(item) => onChange(item.label, item.key)}
        onClear={() => onChange("", null)}
      />
      {text.trim() && !resolved && (
        <span className="sched-unmatched">
          {results.length === 0 ? "Not on the map" : "More than one match — pick from the list"}
        </span>
      )}
    </div>
  );
}
