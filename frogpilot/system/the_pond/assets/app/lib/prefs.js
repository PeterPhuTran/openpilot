// Tiny localStorage wrapper for remembering small UI preferences (the sidebar's folded sections + availability).
// Reads fail closed to a fallback and writes swallow quota/security errors, so a locked-down browser
// (private mode, storage disabled) simply falls back to the defaults instead of throwing.
const PREFIX = "pond.";

export function readPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage unavailable or full — preferences are best-effort, so ignore.
  }
}
