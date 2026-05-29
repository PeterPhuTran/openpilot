import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { formatTimestamp } from "../../lib/format.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { lockScroll, unlockScroll } from "../../lib/scroll_lock.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

function logUrl(name) {
  // Every interpolated filename is encoded: the backend accepts the full filename (incl. ".log") on the
  // <filename> route and rejects any decoded traversal with 400 via safe_join (REWRITE_PLAN §3.5, §14 B11).
  return `/api/error_logs/${encodeURIComponent(name)}`;
}

function hasTimestamp(log) {
  // A foreign / hand-renamed file the backend could not parse arrives without a usable epoch; the row
  // still renders, just without a date/age, so one malformed entry never breaks the list.
  return Number.isFinite(log.created_at);
}

function formatAge(seconds) {
  if (seconds < MINUTE) {
    return strings.errorLogs.ageJustNow;
  }
  if (seconds < HOUR) {
    return strings.errorLogs.ageMinutes(Math.floor(seconds / MINUTE));
  }
  if (seconds < DAY) {
    return strings.errorLogs.ageHours(Math.floor(seconds / HOUR));
  }
  return strings.errorLogs.ageDays(Math.floor(seconds / DAY));
}

function copyText(text) {
  // The device serves plain HTTP, so navigator.clipboard may be unavailable; fall back to the legacy
  // execCommand path (the only branch that can log) for non-secure contexts (REWRITE_PLAN §14 B11).
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }

  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.focus();
  field.select();
  try {
    document.execCommand("copy");
  } catch (error) {
    console.error("Clipboard fallback failed:", error);
    document.body.removeChild(field);
    return Promise.reject(error);
  }
  document.body.removeChild(field);
  return Promise.resolve();
}

function LogViewer({ log, onClose, onDelete }) {
  const [content, setContent] = useState(null);
  const [failed, setFailed] = useState(false);

  const mountedRef = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Mount-only: the latest onClose is read through a ref so a parent re-render cannot re-run the cleanup
  // and abort the in-flight fetch (REWRITE_PLAN §3.4, §12.3). lockScroll/unlockScroll are ref-counted, so
  // a delete-confirm Modal layered above this overlay keeps the lock the overlay still needs.
  useEffect(() => {
    mountedRef.current = true;
    lockScroll();

    const controller = new AbortController();
    http
      .get(logUrl(log.name), { signal: controller.signal })
      .then((text) => {
        if (mountedRef.current) {
          setContent(text);
        }
      })
      .catch((error) => {
        // An aborted fetch on unmount is expected teardown, not a load failure.
        if (mountedRef.current && error.name !== "AbortError") {
          setFailed(true);
        }
      });

    const onKeyDown = (event) => {
      // Ignore Escape while a modal is layered above, so it closes only the top layer.
      if (event.key === "Escape" && !document.querySelector(".modal-overlay")) {
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      mountedRef.current = false;
      controller.abort();
      document.removeEventListener("keydown", onKeyDown);
      unlockScroll();
    };
  }, []);

  const copy = async () => {
    try {
      await copyText(content ?? "");
      showToast(strings.errorLogs.copied);
    } catch {
      showToast(strings.errorLogs.copyFailed, "error");
    }
  };

  const body = failed ? strings.errorLogs.viewerError : content === null ? strings.errorLogs.viewerLoading : content;

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="overlay-panel" onClick=${(event) => event.stopPropagation()}>
        <div class="overlay-head">
          <span class="overlay-title">${log.name}</span>
        </div>
        <pre class="log-content">${body}</pre>
        <div class="overlay-actions">
          <button class="btn" onClick=${onClose}><${Icon} name="close" /> <span>${strings.common.close}</span></button>
          <button class="btn" onClick=${copy} disabled=${content === null || failed}>
            <span>${strings.errorLogs.copy}</span>
          </button>
          <a class="btn" href=${logUrl(log.name)} download=${log.name}>
            <${Icon} name="download" /> <span>${strings.common.download}</span>
          </a>
          <button class="btn btn-danger" onClick=${onDelete}>
            <${Icon} name="trash" /> <span>${strings.common.delete}</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

export function ErrorLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [selected, setSelected] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  const reload = () => setReloadKey((key) => key + 1);

  // Mount/reload-only list fetch. The mounted ref drops a late resolve so the cleanup-on-unmount (which
  // aborts the request) never sets state on a dead component (REWRITE_PLAN §3.4, §15.6).
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    setLoading(true);
    setFailed(false);

    http
      .get("/api/error_logs", { signal: controller.signal })
      .then((data) => {
        if (mounted) {
          setLogs(data);
          setLoading(false);
        }
      })
      .catch((error) => {
        if (mounted && error.name !== "AbortError") {
          setFailed(true);
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [reloadKey]);

  const remove = async (log) => {
    setPendingDelete(null);
    try {
      await http.del(logUrl(log.name));
      if (selected?.name === log.name) {
        setSelected(null);
      }

      showToast(strings.errorLogs.deleted);
      reload();
    } catch (error) {
      showToast(messageFor(error, strings.errorLogs.deleteFailed), "error");
    }
  };

  const removeAll = async () => {
    setConfirmDeleteAll(false);
    try {
      await http.del("/api/error_logs/delete_all");

      setSelected(null);
      showToast(strings.errorLogs.deletedAll);
      reload();
    } catch (error) {
      showToast(messageFor(error, strings.errorLogs.loadFailed), "error");
    }
  };

  const status = renderStatus(failed, loading, logs.length);

  return html`
    <section class="error-logs">
      <header class="error-logs-header">
        <h1 class="error-logs-title">${strings.errorLogs.title}</h1>
        ${logs.length > 0 &&
        html`<button class="btn btn-danger" onClick=${() => setConfirmDeleteAll(true)}>
          <${Icon} name="trash" /> <span>${strings.errorLogs.deleteAll}</span>
        </button>`}
      </header>

      ${status
        ? html`
            <p class="error-logs-message">${status}</p>
            ${failed &&
            html`<button class="btn btn-primary error-logs-retry" onClick=${reload}>${strings.errorLogs.retry}</button>`}
          `
        : html`
            <ul class="error-logs-list">
              ${logs.map(
                (log) =>
                  html`<li key=${log.name}>
                    <button class="error-logs-row" onClick=${() => setSelected(log)}>
                      <span class="error-logs-name">${hasTimestamp(log) ? formatTimestamp(log.created_at) : log.name}</span>
                      ${hasTimestamp(log) &&
                      html`<span class="error-logs-age">${formatAge(Date.now() / 1000 - log.created_at)}</span>`}
                    </button>
                  </li>`,
              )}
            </ul>
          `}
      ${selected &&
      html`<${LogViewer} log=${selected} onClose=${() => setSelected(null)} onDelete=${() => setPendingDelete(selected)} />`}
      ${pendingDelete &&
      html`<${Modal}
        title=${strings.errorLogs.deleteConfirmTitle}
        message=${strings.errorLogs.deleteConfirm(pendingDelete.name)}
        confirmLabel=${strings.common.delete}
        danger
        onConfirm=${() => remove(pendingDelete)}
        onCancel=${() => setPendingDelete(null)}
      />`}
      ${confirmDeleteAll &&
      html`<${Modal}
        title=${strings.errorLogs.deleteAllConfirmTitle}
        message=${strings.errorLogs.deleteAllConfirm}
        confirmLabel=${strings.errorLogs.deleteAll}
        danger
        onConfirm=${removeAll}
        onCancel=${() => setConfirmDeleteAll(false)}
      />`}
    </section>
  `;
}

function renderStatus(failed, loading, count) {
  if (failed) {
    return strings.errorLogs.error;
  }

  if (loading) {
    return strings.errorLogs.loading;
  }

  if (count === 0) {
    return strings.errorLogs.empty;
  }

  return null;
}
