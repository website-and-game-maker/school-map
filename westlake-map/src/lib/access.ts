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

const HASH = (import.meta.env.VITE_EDIT_KEY_SHA256 as string | undefined)?.trim() ?? "";
const STORAGE_KEY = "westlake-map:editor";

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
    // Not being able to remember is survivable: the link still works.
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
 * Decide whether to show the editing tools, and strip the key out of the URL so
 * it does not sit in the address bar to be screenshotted or pasted into a chat.
 *
 * In dev the tools are always available — the whole point of `npm run dev` is to
 * edit the data, and there is nobody to hide them from.
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
    try {
      const hash = await sha256Hex(supplied);
      if (hash === HASH) {
        remember(hash);
        return true;
      }
    } catch {
      return false; // no SubtleCrypto (insecure origin) — fail closed
    }
    return false;
  }

  return remembered() === HASH;
}
