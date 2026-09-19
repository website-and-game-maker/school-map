// The pencil in the corner, and the key box behind it.
//
// This replaces "know that ?edit=… exists and paste the key into the address
// bar". A door you cannot see is not a door, and a secret in a URL is a secret
// on its way into a group chat.
//
// The dialog says what the key looks like before you type. That is not a leak —
// the shape of a string narrows a SHA-256 preimage search by nothing — and
// without it an editor who typed their key in capitals has no way to learn that
// it is lowercase. It describes the shape only; see EDIT_KEY_FORMAT in
// lib/access.ts for why it must not claim to know more than that.

import { useEffect, useId, useRef, useState } from "react";
import { EDIT_KEY_FORMAT, looksLikeKey, unlockWithKey } from "../lib/access";

interface Props {
  /** True once the key has been accepted; the pencil then offers to lock again. */
  unlocked: boolean;
  onUnlock: () => void;
  onLock: () => void;
}

export default function EditorKeyDialog({ unlocked, onUnlock, onLock }: Props) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const typed = key.trim();
    if (!typed) return;
    // Tell the difference between a typo and the wrong key, because the two
    // have completely different fixes.
    if (!looksLikeKey(typed)) {
      setError(`That doesn't look like an editor key. ${EDIT_KEY_FORMAT.hint}`);
      return;
    }
    setBusy(true);
    const ok = await unlockWithKey(typed);
    setBusy(false);
    if (ok) {
      setKey("");
      setError(null);
      setOpen(false);
      onUnlock();
    } else {
      setError("That key doesn't match this build. Ask whoever set the site up.");
    }
  }

  return (
    <>
      <button
        className={`pencil-btn${unlocked ? " unlocked" : ""}`}
        onClick={() => (unlocked ? onLock() : setOpen(true))}
        title={unlocked ? "Editing unlocked — click to lock again" : "Editor sign-in"}
        aria-label={unlocked ? "Lock the editing tools" : "Unlock the editing tools"}
      >
        {/* Labelled, not just a glyph. A bare pencil in the corner of a map is
            as likely to be read as "draw on the map" as "sign in to edit". */}
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
          <path d="M14.5 6.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.9" />
        </svg>
        <span className="pencil-label">{unlocked ? "Editing" : "Edit"}</span>
      </button>

      {open && (
        <div className="key-backdrop" onClick={() => setOpen(false)}>
          <form className="key-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2>Editor key</h2>
            <p className="key-blurb">
              Editing is for people maintaining the map. Everything you change stays in this browser
              until a reviewer merges it — nothing here can change what anyone else sees.
            </p>
            <input
              ref={inputRef}
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setError(null);
              }}
              placeholder={EDIT_KEY_FORMAT.placeholder}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              aria-describedby={hintId}
              aria-invalid={error ? true : undefined}
            />
            <p className="key-hint" id={hintId}>
              {EDIT_KEY_FORMAT.hint}
            </p>
            {error && <p className="key-error">{error}</p>}
            <div className="key-actions">
              <button type="button" className="key-cancel" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="key-submit" disabled={busy || !key.trim()}>
                {busy ? "Checking…" : "Unlock editing"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
