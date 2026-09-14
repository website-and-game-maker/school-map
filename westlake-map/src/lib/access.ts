// Who is allowed to open the editing tools.
//
// Be clear about what this is and is not. The app is a static site on GitHub
// Pages: there is no server, no session, and no way to verify anybody. So this
// is NOT the thing that protects the map. What protects the map is that nothing
// anyone does in a browser can change it — edits live in that tab only, and the
// published map changes exactly when a commit lands on `main`, which needs
// write access to the repository. That is the real access control, and it is
// enforced by GitHub rather than by this file.
//
// What this file does is keep the editing UI out of the way of the ~everyone who
// should not be using it, and make the reviewed-before-real rule visible.
//
// The key is never shipped. Only its SHA-256 is baked into the bundle, so
// reading the JavaScript does not hand you the key — you would have to brute
// force a preimage. That is a real improvement over a plaintext check, and it
// is still not a security boundary: treat it as a lock on a door that has no
// walls around it.
//
// The key used to be supplied as `?edit=…` in the URL and nothing else, which
// had two problems worth fixing. It is unguessable that the query parameter
// exists at all, so an editor who forgets the URL has no way back in; and a URL
// carrying a secret gets screenshotted, bookmarked and pasted into group chats.
// So the door is now a pencil in the corner that asks for the key. The query
// parameter still works, because links to it exist, but it is no longer the
// only way and the key is stripped out of the address bar on arrival.

const HASH = (import.meta.env.VITE_EDIT_KEY_SHA256 as string | undefined)?.trim() ?? "";
const STORAGE_KEY = "westlake-map:editor";

/**
 * What to tell someone staring at an empty key box. Describing the SHAPE of the
 * key is not a leak — it narrows a brute force by nothing that matters against
 * SHA-256 — and without it the honest editor cannot tell "I mistyped" from
 * "I have the wrong key entirely".
 */
export const EDIT_KEY_FORMAT = {
  placeholder: "chap-xxxx-xxxx",
  hint: "Three lowercase groups joined by hyphens, starting with “chap” — for example chap-court-1976. Case and hyphens both matter.",
  pattern: /^[a-z0-9]+(-[a-z0-9]+){1,3}$/,
} as const;

/** Does this even look like a key? Cheap client-side sanity check, no crypto. */
export function looksLikeKey(text: string): boolean {
  return EDIT_KEY_FORMAT.pattern.test(text.trim());
}

/** True when this build has no key configured, so editing is impossible. */
export const EDITING_CONFIGURED = HASH.length > 0 || import.meta.env.DEV;

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // private window, or site data blocked
  }
}

function remember(hash: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, hash);
  } catch {
    // Not being able to remember is survivable: the key can be entered again.
  }
}

export function forgetEditor(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Check a key typed into the pencil dialog. Returns true and remembers it on a
 * match; returns false without remembering anything otherwise.
 */
export async function unlockWithKey(key: string): Promise<boolean> {
  // In dev every key opens the tools, because the whole point of `npm run dev`
  // is to edit the data and there is nobody to hide them from.
  if (import.meta.env.DEV) return true;
  if (!HASH) return false;
  try {
    const hash = await sha256Hex(key.trim());
    if (hash !== HASH) return false;
    remember(hash);
    return true;
  } catch {
    return false; // no SubtleCrypto (insecure origin) — fail closed
  }
}

/**
 * Decide whether to show the editing tools on load, and strip any key out of
 * the URL so it does not sit in the address bar to be screenshotted.
 */
export async function resolveEditAccess(): Promise<boolean> {
  if (import.meta.env.DEV) return true;
  // No key configured for this build means nobody can edit the published site.
  // That is the safe default: a missing secret must not open the door.
  if (!HASH) return false;

  const url = new URL(window.location.href);
  const supplied = url.searchParams.get("edit");
  if (supplied) {
    url.searchParams.delete("edit");
    window.history.replaceState(null, "", url.toString());
    return unlockWithKey(supplied);
  }

  return remembered() === HASH;
}
