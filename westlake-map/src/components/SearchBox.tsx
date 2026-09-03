// Autocomplete used for both ends of a route. Keyboard-first: ↑/↓ to move,
// Enter to pick, Esc to close — a phone user taps, but anyone at a laptop
// should never have to reach for the mouse.

import { useEffect, useId, useRef, useState } from "react";
import type { SearchItem, SearchKind } from "../lib/search";

const KIND_TAG: Record<SearchKind, string> = {
  room: "Room",
  entrance: "Entrance",
  landmark: "Place",
  restroom: "Restroom",
  "nearest-restroom": "Closest one",
};

interface Props {
  label: string;
  placeholder: string;
  value: string;
  results: SearchItem[];
  floorLabel: (item: SearchItem) => string | null;
  onQueryChange: (q: string) => void;
  onPick: (item: SearchItem) => void;
  onClear: () => void;
  autoFocus?: boolean;
}

export default function SearchBox({
  label,
  placeholder,
  value,
  results,
  floorLabel,
  onQueryChange,
  onPick,
  onClear,
  autoFocus,
}: Props) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    setHighlight(0);
  }, [value]);

  const showList = open && results.length > 0;

  function pick(item: SearchItem) {
    onPick(item);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!showList) {
      if (e.key === "ArrowDown" && results.length > 0) setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[highlight];
      if (item) pick(item);
    }
  }

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <div className="input-wrap">
        <input
          id={inputId}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          autoFocus={autoFocus}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${inputId}-list`}
        />
        {value && (
          <button
            className="input-clear"
            aria-label={`Clear ${label}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClear();
              setOpen(false);
            }}
          >
            ×
          </button>
        )}
      </div>

      {showList && (
        <ul className="suggestions" id={`${inputId}-list`} role="listbox" ref={listRef}>
          {results.map((item, i) => {
            const floor = floorLabel(item);
            return (
              <li key={item.key} role="option" aria-selected={i === highlight}>
                <button
                  className={i === highlight ? "highlighted" : ""}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => e.preventDefault()} // keep focus so blur doesn't close first
                  onClick={() => pick(item)}
                >
                  <span className="sugg-label">{item.label}</span>
                  <span className="sugg-meta">
                    <span className="sugg-kind">{KIND_TAG[item.kind]}</span>
                    {floor && <span className="sugg-floor">{floor}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
