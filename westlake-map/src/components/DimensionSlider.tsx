// The 3D dial: one slider from a flat plan to an exploded stack.
//
// It replaces a "2D Plan / 3D View" pair of buttons. Those were not two
// features — they were the two ends of one continuum, and presenting them as a
// choice hid the interesting part, which is everything in between. The middle
// of this slider is where you can see that the Cafeteria is directly under the
// main corridor, and no toggle can show you that.
//
// The stops are labelled and clickable, because a bare slider does not tell you
// what it does until you have already moved it, and because the three named
// positions are genuinely the ones people want.

import { DIMENSION_STOPS } from "../three/units";

interface Props {
  value: number;
  onChange: (v: number) => void;
  /** Editing works on the flat plan, so the dial is pinned there while it's on. */
  disabled?: boolean;
}

const NEAR = 0.06;

export default function DimensionSlider({ value, onChange, disabled }: Props) {
  const pct = Math.round(value * 100);
  const active = DIMENSION_STOPS.find((s) => Math.abs(s.at - value) < NEAR);

  return (
    <div className={`dim-slider${disabled ? " disabled" : ""}`}>
      <div className="dim-head">
        <span className="dim-title">3D</span>
        <span className="dim-now">{active ? active.label : `${pct}%`}</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        disabled={disabled}
        aria-label="Amount of 3D, from a flat plan to an exploded stack of floors"
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <div className="dim-stops">
        {DIMENSION_STOPS.map((s) => (
          <button
            key={s.label}
            type="button"
            className={active?.label === s.label ? "active" : ""}
            disabled={disabled}
            onClick={() => onChange(s.at)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {disabled && <p className="dim-note">Editing works on the flat plan.</p>}
    </div>
  );
}
