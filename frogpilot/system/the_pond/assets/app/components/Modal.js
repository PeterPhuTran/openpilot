import { useEffect, useRef } from "preact/hooks";

import { trapFocus } from "../lib/focus_trap.js";
import { html } from "../lib/html.js";
import { lockScroll, unlockScroll } from "../lib/scroll_lock.js";
import { strings } from "../lib/strings.js";

let modalId = 0;

// Confirmation dialog with a focus trap, scroll lock, ESC-to-cancel, and focus restoration. The
// useEffect cleanup removes every listener and unlocks scrolling, so the modal leaves nothing behind
// (REWRITE_PLAN §3.4, §5.2).
export function Modal({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel, danger = false, children }) {
  const dialogRef = useRef(null);
  const titleIdRef = useRef(null);
  const messageIdRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  if (!titleIdRef.current) {
    modalId += 1;
    titleIdRef.current = `modal-title-${modalId}`;
    messageIdRef.current = `modal-message-${modalId}`;
  }
  onCancelRef.current = onCancel;

  // Mount-only: a parent re-render (e.g. recordings still streaming behind the dialog) must not re-run
  // this cleanup and steal focus back. The latest onCancel is read through a ref.
  useEffect(() => {
    const previousFocus = document.activeElement;
    lockScroll();

    // Prefer the text field; otherwise focus Cancel on destructive dialogs so Enter cannot fire the
    // irreversible action, and Confirm on benign ones.
    const dialog = dialogRef.current;
    const initialFocus =
      dialog?.querySelector(".modal-field") || dialog?.querySelector(danger ? ".modal-cancel" : ".modal-confirm");
    initialFocus?.focus();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        onCancelRef.current();
      } else if (event.key === "Tab") {
        trapFocus(event, dialogRef.current);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unlockScroll();
      previousFocus?.focus?.();
    };
  }, []);

  return html`
    <div class="modal-overlay" onClick=${onCancel}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby=${titleIdRef.current}
        aria-describedby=${messageIdRef.current}
        ref=${dialogRef}
        onClick=${(event) => event.stopPropagation()}
      >
        <h2 id=${titleIdRef.current} class="modal-title">${title}</h2>
        <p id=${messageIdRef.current} class="modal-message">${message}</p>
        ${children}
        <div class="modal-actions">
          <button class="btn btn-ghost modal-cancel" onClick=${onCancel}>${cancelLabel || strings.common.cancel}</button>
          <button class=${`btn ${danger ? "btn-danger" : "btn-primary"} modal-confirm`} onClick=${onConfirm}>
            ${confirmLabel || strings.common.save}
          </button>
        </div>
      </div>
    </div>
  `;
}
