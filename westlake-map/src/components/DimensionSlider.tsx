// The tilt dial: one vertical slider in the corner of the map.
//
// It lives on the map rather than in the panel because it is a camera control,
// and camera controls belong next to the thing they aim. Vertical because what
// it controls is vertical — push it up to stand the view up, pull it down to
// look straight down — and putting the plan end at the bottom would invert that.
//
// Deliberately unlabelled beyond its two end icons. An earlier version had
// named stops ("Flat / Building / Exploded") because the dial also opened and
// closed the storey stack; now that it only tilts, stops would be three names
// for three camera angles, which is three more words than the control needs.

interface Props {
  value: number;
  onChange: (v: number) => void;
  /** Editing works on the flat plan, so the dial is hidden while it's on. */
  disabled?: boolean;
}

export default function DimensionSlider({ value, onChange, disabled }: Props) {
  const pct = Math.round(value * 100);

  return (
    <div className={`tilt-dial${disabled ? " disabled" : ""}`}>
      <span className="tilt-icon" aria-hidden="true" title="Tilted view">
        <svg viewBox="0 0 20 20" width="15" height="15">
          <path
            d="M2 13.5 L10 9 L18 13.5 L10 18 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M10 9 L10 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        disabled={disabled}
        aria-label="Camera tilt, from straight down to across"
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="tilt-icon" aria-hidden="true" title="Straight down">
        <svg viewBox="0 0 20 20" width="15" height="15">
          <rect
            x="3.5"
            y="3.5"
            width="13"
            height="13"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
      </span>
    </div>
  );
}
