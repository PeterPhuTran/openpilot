import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { formatTimestamp } from "../../lib/format.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { openStream } from "../../lib/sse.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

function displayName(log) {
  // Auto-named captures parse cleanly, so show the friendly date; a hand-renamed log keeps its raw name
  // (mirrors B3/B11 is_custom_name handling).
  return log.is_custom_name ? log.name.replace(/_/g, " ") : formatTimestamp(log.created_at);
}

function formatAge(seconds) {
  if (seconds < MINUTE) {
    return strings.tmux.ageJustNow;
  }
  if (seconds < HOUR) {
    return strings.tmux.ageMinutes(Math.floor(seconds / MINUTE));
  }
  if (seconds < DAY) {
    return strings.tmux.ageHours(Math.floor(seconds / HOUR));
  }
  return strings.tmux.ageDays(Math.floor(seconds / DAY));
}

function LiveConsole() {
  const [buffer, setBuffer] = useState("");
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);

  const preRef = useRef(null);
  // The latest buffer/paused values are read through refs inside the mount-only effect so a re-render
  // (a new frame arriving, the pause toggle) never tears down and re-opens the stream.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const latestRef = useRef("");

  // Mount-only: open one stream and close it on unmount. Keeping it out of any dependency list is the fix
  // for the old EventSource that was never closed on navigate-away (REWRITE_PLAN §3.4); the leak test
  // proves the abort by failing the in-flight /live request when the view unmounts.
  useEffect(() => {
    setBuffer("");
    setFailed(false);

    const stream = openStream("/api/tmux_log/live", {
      onMessage: (event) => {
        if (event.event === "start") {
          latestRef.current = "";
          setBuffer("");
        } else if (event.event === "log") {
          latestRef.current = event.content;
          if (!pausedRef.current) {
            setBuffer(event.content);
          }
        }
      },
      onError: () => {
        setFailed(true);
        showToast(strings.tmux.liveError, "error");
      },
    });

    return () => stream.close();
  }, []);

  // Follow the tail to the bottom after each new frame unless paused, so the newest console output stays
  // in view without yanking the scroll position away from a user who paused to read.
  useEffect(() => {
    const pre = preRef.current;
    if (pre && !paused) {
      pre.scrollTop = pre.scrollHeight;
    }
  }, [buffer, paused]);

  const togglePause = () => {
    setPaused((current) => {
      const next = !current;
      // Resuming jumps straight to the latest buffer so the console is never stuck on a stale frame.
      if (!next) {
        setBuffer(latestRef.current);
      }
      return next;
    });
  };

  // Resolve the console body to a single expression so the whitespace-significant <pre> stays on one
  // line (a wrapped <pre> open tag would inject a rendered leading newline).
  const consoleText = failed ? strings.tmux.liveError : buffer;

  return html`
    <section class="tmux-live">
      <header class="tmux-live-head">
        <h2 class="tmux-live-title"><${Icon} name="terminal" /> <span>${strings.tmux.liveTitle}</span></h2>
        <button class="btn" onClick=${togglePause} aria-pressed=${paused}>
          <span>${paused ? strings.tmux.resume : strings.tmux.pause}</span>
        </button>
      </header>
      ${paused && html`<p class="tmux-live-paused" role="status">${strings.tmux.paused}</p>`}
      <pre class="tmux-console" ref=${preRef} aria-label=${strings.tmux.liveTitle}>${consoleText}</pre>
    </section>
  `;
}

function SavedLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [pendingDelete, setPendingDelete] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const reload = () => setReloadKey((key) => key + 1);

  // Mount/reload-only list fetch. The mounted flag drops a late resolve so the cleanup-on-unmount (which
  // aborts the request) never sets state on a dead component (REWRITE_PLAN §3.4, §15.6).
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    setLoading(true);
    setFailed(false);

    http
      .get("/api/tmux_log/list", { signal: controller.signal })
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

  const capture = async () => {
    try {
      await http.post("/api/tmux_log/capture");
      showToast(strings.tmux.captured);
      reload();
    } catch (error) {
      showToast(messageFor(error, strings.tmux.captureFailed), "error");
    }
  };

  const remove = async (log) => {
    setPendingDelete(null);
    try {
      await http.del(`/api/tmux_log/delete/${encodeURIComponent(log.name)}`);
      setLogs((current) => current.filter((entry) => entry.name !== log.name));
      showToast(strings.tmux.deleted);
    } catch (error) {
      showToast(messageFor(error, strings.tmux.deleteFailed), "error");
    }
  };

  const removeAll = async () => {
    setConfirmDeleteAll(false);
    try {
      await http.del("/api/tmux_log/delete_all");
      setLogs([]);
      showToast(strings.tmux.deletedAll);
    } catch (error) {
      showToast(messageFor(error, strings.tmux.deleteFailed), "error");
    }
  };

  const startRename = (log) => {
    setRenameValue(log.is_custom_name ? log.name : "");
    setRenaming(log);
  };

  const submitRename = async () => {
    const next = renameValue.trim();
    if (!next) {
      return;
    }

    try {
      await http.post("/api/tmux_log/rename", { old: renaming.name, new: next });
      setRenaming(null);
      showToast(strings.tmux.renamed);
      reload();
    } catch (error) {
      showToast(messageFor(error, strings.tmux.renameFailed), "error");
    }
  };

  const status = renderStatus(failed, loading, logs.length);

  return html`
    <section class="tmux-saved">
      <header class="tmux-saved-head">
        <h2 class="tmux-saved-title">${strings.tmux.savedTitle}</h2>
        <div class="tmux-saved-actions">
          <button class="btn btn-primary" onClick=${capture}>
            <span>${strings.tmux.capture}</span>
          </button>
          ${logs.length > 0 &&
          html`<button class="btn btn-danger" onClick=${() => setConfirmDeleteAll(true)}>
            <${Icon} name="trash" /> <span>${strings.tmux.deleteAll}</span>
          </button>`}
        </div>
      </header>

      ${status
        ? html`
            <p class="tmux-saved-message">${status}</p>
            ${failed && html`<button class="btn btn-primary tmux-saved-retry" onClick=${reload}>${strings.tmux.retry}</button>`}
          `
        : html`
            <ul class="tmux-saved-list">
              ${logs.map(
                (log) =>
                  html`<li class="tmux-saved-item" key=${log.name}>
                    <div class="tmux-saved-info">
                      <span class="tmux-saved-name">${displayName(log)}</span>
                      <span class="tmux-saved-age">${formatAge(Date.now() / 1000 - log.created_at)}</span>
                    </div>
                    <div class="tmux-saved-row-actions">
                      <a
                        class="btn"
                        href=${`/api/tmux_log/download/${encodeURIComponent(log.name)}`}
                        download=${`${log.name}.log`}
                      >
                        <${Icon} name="download" /> <span>${strings.common.download}</span>
                      </a>
                      <button class="btn" onClick=${() => startRename(log)}>
                        <${Icon} name="edit" /> <span>${strings.tmux.rename}</span>
                      </button>
                      <button class="btn btn-danger" onClick=${() => setPendingDelete(log)}>
                        <${Icon} name="trash" /> <span>${strings.common.delete}</span>
                      </button>
                    </div>
                  </li>`,
              )}
            </ul>
          `}
      ${pendingDelete &&
      html`<${Modal}
        title=${strings.tmux.deleteConfirmTitle}
        message=${strings.tmux.deleteConfirm(displayName(pendingDelete))}
        confirmLabel=${strings.common.delete}
        danger
        onConfirm=${() => remove(pendingDelete)}
        onCancel=${() => setPendingDelete(null)}
      />`}
      ${confirmDeleteAll &&
      html`<${Modal}
        title=${strings.tmux.deleteAllConfirmTitle}
        message=${strings.tmux.deleteAllConfirm}
        confirmLabel=${strings.tmux.deleteAll}
        danger
        onConfirm=${removeAll}
        onCancel=${() => setConfirmDeleteAll(false)}
      />`}
      ${renaming &&
      html`<${Modal}
        title=${strings.tmux.renameTitle}
        message=${strings.tmux.renameLabel}
        confirmLabel=${strings.common.save}
        onConfirm=${submitRename}
        onCancel=${() => setRenaming(null)}
      >
        <input
          class="modal-field"
          value=${renameValue}
          onInput=${(event) => setRenameValue(event.target.value)}
          onKeyDown=${(event) => event.key === "Enter" && submitRename()}
          aria-label=${strings.tmux.renameLabel}
        />
      <//>`}
    </section>
  `;
}

export function Tmux() {
  return html`
    <section class="tmux">
      <h1 class="tmux-title">${strings.tmux.title}</h1>
      <${LiveConsole} />
      <${SavedLogs} />
    </section>
  `;
}

function renderStatus(failed, loading, count) {
  if (failed) {
    return strings.tmux.loadError;
  }

  if (loading) {
    return strings.tmux.loading;
  }

  if (count === 0) {
    return strings.tmux.empty;
  }

  return null;
}
