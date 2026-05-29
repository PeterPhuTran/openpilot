import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

// The two door actions, declared once so the buttons and their confirm dialogs share one source of
// truth. `verb` keys into the strings block; `url` is the POST endpoint; `successKey`/`failureKey` pick
// the toast copy (the 400/502/503 responses carry the server's own message, used in preference to the
// generic failure copy).
const ACTIONS = {
  lock: {
    confirm: strings.doors.lockConfirm,
    confirmTitle: strings.doors.lockConfirmTitle,
    failureFallback: strings.doors.lockFailed,
    label: strings.doors.lock,
    success: strings.doors.locked,
    url: "/api/doors/lock",
  },
  unlock: {
    confirm: strings.doors.unlockConfirm,
    confirmTitle: strings.doors.unlockConfirmTitle,
    failureFallback: strings.doors.unlockFailed,
    label: strings.doors.unlock,
    success: strings.doors.unlocked,
    url: "/api/doors/unlock",
  },
};

export function Doors() {
  const [pending, setPending] = useState(null);
  const [inFlight, setInFlight] = useState(false);

  // The action is a one-shot POST with no stream/interval/listener/<video>/objectURL, so the only
  // teardown surface is ignoring a late resolve after unmount: a mid-request navigation must not call
  // setState on a dead component. The Modal itself owns its focus-trap/scroll-lock/focus-restore.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (key) => {
    const action = ACTIONS[key];
    setPending(null);
    setInFlight(true);

    try {
      await http.post(action.url);
      if (mounted.current) {
        showToast(action.success);
      }
    } catch (error) {
      if (mounted.current) {
        showToast(messageFor(error, action.failureFallback), "error");
      }
    } finally {
      if (mounted.current) {
        setInFlight(false);
      }
    }
  };

  const confirming = pending ? ACTIONS[pending] : null;

  return html`
    <section class="doors">
      <div class="doors-panel">
        <h1 class="doors-title">${strings.doors.title}</h1>
        <p class="doors-text">${strings.doors.intro}</p>
        <div class="doors-actions">
          <button class="btn btn-primary" onClick=${() => setPending("lock")} disabled=${inFlight}>
            <${Icon} name="door" /> <span>${strings.doors.lock}</span>
          </button>
          <button class="btn" onClick=${() => setPending("unlock")} disabled=${inFlight}>
            <${Icon} name="door" /> <span>${strings.doors.unlock}</span>
          </button>
        </div>
      </div>

      ${confirming &&
      html`<${Modal}
        title=${confirming.confirmTitle}
        message=${confirming.confirm}
        confirmLabel=${confirming.label}
        danger
        onConfirm=${() => run(pending)}
        onCancel=${() => setPending(null)}
      />`}
    </section>
  `;
}
