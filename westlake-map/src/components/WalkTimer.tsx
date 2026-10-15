// "Time this walk" — the button in the directions card that turns a real walk
// into a timing report (lib/timing.ts). Tap when you set off, tap "I'm here"
// when you arrive. The running timer lives in storage, so locking the phone or
// reloading the page mid-walk doesn't lose it.

import { useEffect, useState } from "react";
import {
  isShared,
  loadActiveWalk,
  rejectReason,
  saveActiveWalk,
  submitReport,
  type ActiveWalk,
  type TimingReport,
} from "../lib/timing";

interface Props {
  from: { key: string; label: string };
  to: { key: string; label: string };
  feet: number;
  flights: number;
  /** Called after a report is recorded, so the estimate can pick it up. */
  onReported: (report: TimingReport) => void;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function WalkTimer({ from, to, feet, flights, onReported }: Props) {
  const [active, setActive] = useState<ActiveWalk | null>(() => loadActiveWalk());
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const start = () => {
    const walk: ActiveWalk = {
      from: from.key,
      to: to.key,
      fromLabel: from.label,
      toLabel: to.label,
      feet,
      flights,
      startedAt: Date.now(),
    };
    saveActiveWalk(walk);
    setActive(walk);
    setNow(walk.startedAt);
    setMessage(null);
  };

  const cancel = () => {
    saveActiveWalk(null);
    setActive(null);
  };

  const arrive = () => {
    if (!active) return;
    const end = Date.now();
    const report: TimingReport = {
      from: active.from,
      to: active.to,
      feet: Math.round(active.feet),
      flights: active.flights,
      seconds: Math.round((end - active.startedAt) / 1000),
      at: end,
    };
    saveActiveWalk(null);
    setActive(null);
    const problem = rejectReason(report);
    if (problem) {
      setMessage(`Not counted: ${problem}`);
      return;
    }
    void submitReport(report);
    onReported(report);
    setMessage(
      `Thanks! Logged ${clock(report.seconds * 1000)}${isShared ? "" : " on this device"}.`
    );
  };

  // A walk is running, possibly for a different route than the one shown now:
  // say which, so "I'm here" is never tapped against the wrong destination.
  if (active) {
    const elsewhere = active.from !== from.key || active.to !== to.key;
    return (
      <div className="walk-timer running" role="status">
        <div className="walk-timer-row">
          <span className="walk-timer-clock">{clock(now - active.startedAt)}</span>
          <span className="walk-timer-what">
            {elsewhere ? `Timing ${active.fromLabel} → ${active.toLabel}` : "Timing your walk"}
          </span>
        </div>
        <div className="walk-timer-row">
          <button className="walk-timer-arrive" onClick={arrive}>
            I'm here
          </button>
          <button className="walk-timer-cancel" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="walk-timer">
      <button className="walk-timer-start" onClick={start}>
        ⏱ Time this walk
      </button>
      <span className="walk-timer-why">
        {message ?? "Helps everyone get better time estimates."}
      </span>
    </div>
  );
}
