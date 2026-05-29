// Shared focus-trap primitive for overlays — the modal dialog and the mobile sidebar drawer both reuse
// it so Tab / Shift+Tab cycle within `container` and keyboard focus can't escape behind the overlay.
export const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

function isVisibleFocusable(element) {
  const style = window.getComputedStyle(element);
  return !element.disabled && style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

export function trapFocus(event, container) {
  const focusable = [...(container?.querySelectorAll(FOCUSABLE) || [])].filter(isVisibleFocusable);
  if (!focusable || !focusable.length) {
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
