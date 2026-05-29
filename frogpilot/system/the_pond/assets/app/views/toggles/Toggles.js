import { useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { CSRF_HEADERS, errorMessage, http, HttpError, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

const BACKUP_URL = "/api/toggles/backup";
const RESTORE_URL = "/api/toggles/restore";
const RESET_DEFAULT_URL = "/api/toggles/reset_default";
const RESET_STOCK_URL = "/api/toggles/reset_stock";
const BACKUP_FILENAME = "toggle-backup.json";

// The reset confirmation modals are keyed so a single <Modal> renders whichever danger action is pending;
// each entry carries its own copy + endpoint so the two resets share one render path.
const RESET_ACTIONS = {
  default: {
    confirm: () => strings.toggles.resetDefaultConfirm,
    confirmLabel: () => strings.toggles.resetDefault,
    title: () => strings.toggles.resetDefaultConfirmTitle,
    url: RESET_DEFAULT_URL,
  },
  stock: {
    confirm: () => strings.toggles.resetStockConfirm,
    confirmLabel: () => strings.toggles.resetStock,
    title: () => strings.toggles.resetStockConfirmTitle,
    url: RESET_STOCK_URL,
  },
};

async function downloadBackup() {
  // Backup is a POST that returns a JSON attachment, so the GET-only anchor download trick cannot drive it
  // and http.post would consume the file as text. Fetch it as a blob, hand it to the browser through an
  // object URL, then revoke that URL so it is never leaked (REWRITE_PLAN §3.4 — the old theme_maker.js
  // download leaked one).
  const response = await fetch(BACKUP_URL, { method: "POST", headers: CSRF_HEADERS });
  if (!response.ok) {
    throw new HttpError(await errorMessage(response), response.status);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = BACKUP_FILENAME;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function restoredCount(serverMessage) {
  // The server reports "Restored N toggles"; pull N back out so the toast can pluralize independently of
  // the server copy. Falls back to 0 (which the string renders as "0 toggles") if the shape ever changes.
  const match = /\d+/.exec(serverMessage ?? "");
  return match ? Number(match[0]) : 0;
}

function statusClass(status) {
  return status ? `toggles-status is-${status.kind}` : "toggles-status";
}

// A single static panel: no fetch on mount and no stream/interval/listener/<video>/objectURL that outlives
// a click, so there is no useEffect teardown surface (§11). The restore file input is rendered inside the
// component tree (not appended to document.body) so it unmounts with the view — fixing the old toggles.js
// leak that appended a hidden input on every mount and never removed it (REWRITE_PLAN §3.4).
export function Toggles() {
  const [busy, setBusy] = useState(false);
  const [resetAction, setResetAction] = useState(null);
  const [restoreFileName, setRestoreFileName] = useState("");
  const [status, setStatus] = useState(null);
  const fileInputRef = useRef(null);

  const runExclusive = async (action) => {
    // One action at a time: backup/restore/reset all reboot or mutate params, so a second click while one
    // is in flight is ignored (prevents a double restore or a download race).
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const backup = () =>
    runExclusive(async () => {
      try {
        await downloadBackup();
        setStatus({ kind: "success", text: strings.toggles.backupStarted });
        showToast(strings.toggles.backupStarted);
      } catch (error) {
        const text = messageFor(error, strings.toggles.backupError);
        setStatus({ kind: "error", text });
        showToast(text, "error");
      }
    });

  const pickRestoreFile = () => {
    if (busy) {
      return;
    }
    fileInputRef.current?.click();
  };

  const restore = (event) => {
    const input = event.target;
    const file = input.files?.[0];
    // Clear the input value so picking the same file twice still fires onChange.
    input.value = "";
    if (!file) {
      return;
    }
    setRestoreFileName(file.name);

    return runExclusive(async () => {
      try {
        const text = await file.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          setStatus({ kind: "error", text: strings.toggles.restoreError });
          showToast(strings.toggles.restoreError, "error");
          return;
        }

        const result = await http.post(RESTORE_URL, payload);
        const success = strings.toggles.restoreSuccess(restoredCount(result?.message));
        setStatus({ kind: "success", text: success });
        showToast(success);
      } catch (error) {
        const text = messageFor(error, strings.toggles.restoreError);
        setStatus({ kind: "error", text });
        showToast(text, "error");
      }
    });
  };

  const confirmReset = () => {
    const action = RESET_ACTIONS[resetAction];
    setResetAction(null);
    if (!action) {
      return;
    }

    return runExclusive(async () => {
      try {
        await http.post(action.url);
        setStatus({ kind: "success", text: strings.toggles.resetStarted });
        showToast(strings.toggles.resetStarted);
      } catch (error) {
        const text = messageFor(error, strings.toggles.resetError);
        setStatus({ kind: "error", text });
        showToast(text, "error");
      }
    });
  };

  const pendingReset = resetAction ? RESET_ACTIONS[resetAction] : null;

  return html`
    <section class="toggles">
      <h1 class="toggles-title">${strings.toggles.title}</h1>

      <div class="toggles-panel">
        <h2 class="toggles-subtitle">${strings.toggles.backupRestoreTitle}</h2>
        <p class="toggles-text">${strings.toggles.backupDescription}</p>
        <div class=${`toggles-actions ${busy ? "is-busy" : ""}`}>
          <button class="btn btn-primary" onClick=${backup} disabled=${busy}>
            <${Icon} name="download" /> <span>${strings.toggles.backup}</span>
          </button>
          <button class="btn" onClick=${pickRestoreFile} disabled=${busy}>
            <${Icon} name="toggle" /> <span>${strings.toggles.restore}</span>
          </button>
        </div>
        <input
          class="toggles-file-input"
          ref=${fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange=${restore}
          aria-hidden="true"
          tabindex="-1"
        />
        <p class="toggles-file-name">${restoreFileName || strings.toggles.noRestoreFile}</p>
      </div>

      <div class="toggles-panel toggles-panel-danger">
        <h2 class="toggles-subtitle">${strings.toggles.resetTitle}</h2>
        <p class="toggles-text">${strings.toggles.resetDescription}</p>
        <div class=${`toggles-actions ${busy ? "is-busy" : ""}`}>
          <button class="btn btn-danger" onClick=${() => setResetAction("default")} disabled=${busy}>
            <${Icon} name="refresh" /> <span>${strings.toggles.resetDefault}</span>
          </button>
          <button class="btn btn-danger" onClick=${() => setResetAction("stock")} disabled=${busy}>
            <${Icon} name="refresh" /> <span>${strings.toggles.resetStock}</span>
          </button>
        </div>
      </div>

      ${status && html`<p class=${statusClass(status)} role=${status.kind === "error" ? "alert" : "status"}>${status.text}</p>`}
      ${pendingReset &&
      html`<${Modal}
        title=${pendingReset.title()}
        message=${pendingReset.confirm()}
        confirmLabel=${pendingReset.confirmLabel()}
        danger
        onConfirm=${confirmReset}
        onCancel=${() => setResetAction(null)}
      />`}
    </section>
  `;
}
