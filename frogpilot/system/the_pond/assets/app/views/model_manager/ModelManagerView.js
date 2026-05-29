import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

const STATUS_POLL_MS = 1500;
const DEFAULT_PREFERENCES = { AutomaticallyDownloadModels: false, ModelRandomizer: false, selected_model: null };

// A download is in flight while any of the three status fields is set: the bulk flag, the single model
// being fetched, or the progress text. The view polls /api/models/status only while this holds and stops
// (re-fetching the catalog so the installed badges refresh) once it returns to idle.
function isActive(status) {
  return Boolean(status && (status.download_all_active || status.downloading_model || status.progress));
}

function ModelRow({ model, onDownload, onSelect, onDelete }) {
  const rowClass = [
    "model-row",
    model.is_selected && "is-selected",
    model.is_default && "is-default",
    !model.installed && "not-installed",
  ]
    .filter(Boolean)
    .join(" ");

  return html`
    <li class=${rowClass} data-key=${model.key}>
      <div class="model-info">
        <span class="model-name">${model.name}</span>
        <span class="model-meta">
          ${model.version && html`<span class="model-version">${model.version}</span>`}
          ${model.is_selected &&
          html`<span class="model-badge model-badge-selected">${strings.modelManager.selectedBadge}</span>`}
          ${!model.is_selected &&
          model.installed &&
          html`<span class="model-badge">${strings.modelManager.installedBadge}</span>`}
        </span>
      </div>
      <div class="model-actions">
        ${!model.installed &&
        html`<button class="btn btn-primary model-download" onClick=${() => onDownload(model)}>
          <${Icon} name="download" /> <span>${strings.modelManager.download}</span>
        </button>`}
        ${model.installed &&
        !model.is_selected &&
        html`<button class="btn model-select" onClick=${() => onSelect(model)}>${strings.modelManager.select}</button>`}
        ${model.installed &&
        !model.is_selected &&
        html`<button
          class="btn btn-danger model-delete"
          aria-label=${strings.modelManager.delete}
          onClick=${() => onDelete(model)}
        >
          <${Icon} name="trash" /> <span>${strings.modelManager.delete}</span>
        </button>`}
      </div>
    </li>
  `;
}

export function ModelManagerView() {
  const [models, setModels] = useState([]);
  const [preferences, setPreferences] = useState(null);
  const [status, setStatus] = useState({ download_all_active: false, downloading_model: null, progress: null });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [polling, setPolling] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [pendingDelete, setPendingDelete] = useState(null);

  const mountedRef = useRef(true);
  const reload = () => setReloadKey((key) => key + 1);

  // Mount/reload-only fetch. The catalog is the primary content and the only one that gates the
  // loading/error state; preferences and status are secondary and degrade gracefully, so a failure on
  // either still leaves the catalog and the (default-valued) preference toggles usable. The mounted ref
  // drops a late resolve so the cleanup-on-unmount (which aborts the requests) never sets state on a dead
  // component (REWRITE_PLAN §3.4).
  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();

    setLoading(true);
    setFailed(false);

    http
      .get("/api/models/catalog", { signal: controller.signal })
      .then((catalog) => {
        if (mountedRef.current) {
          setModels(catalog);
          setLoading(false);
        }
      })
      .catch((error) => {
        // An aborted fetch on unmount is expected teardown, not a load failure.
        if (mountedRef.current && error.name !== "AbortError") {
          setFailed(true);
          setLoading(false);
        }
      });

    http
      .get("/api/models/preferences", { signal: controller.signal })
      .then((prefs) => {
        if (mountedRef.current) {
          setPreferences(prefs);
        }
      })
      .catch((error) => {
        // Preferences are not load-critical: keep the toggles visible at their defaults so the user can
        // still flip one (and learn about a write failure through its own toast).
        if (mountedRef.current && error.name !== "AbortError") {
          setPreferences(DEFAULT_PREFERENCES);
        }
      });

    http
      .get("/api/models/status", { signal: controller.signal })
      .then((downloadStatus) => {
        if (mountedRef.current) {
          setStatus(downloadStatus);
          setPolling(isActive(downloadStatus));
        }
      })
      .catch(() => {
        // A status read failure leaves the idle default; the poll (once a download starts) recovers it.
      });

    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [reloadKey]);

  // Status poll, keyed on whether a download is active. Setting `polling` false (terminal status) re-runs
  // this effect and clears the interval; unmount runs the same cleanup, so no /api/models/status request
  // can fire after the view is gone (the leak test asserts exactly this — REWRITE_PLAN §3.4, §15.6).
  useEffect(() => {
    if (!polling) {
      return undefined;
    }

    const timer = setInterval(async () => {
      try {
        const next = await http.get("/api/models/status");
        if (!mountedRef.current) {
          return;
        }

        setStatus(next);
        if (!isActive(next)) {
          // The download finished (or was cancelled): stop polling and refresh the catalog so the newly
          // installed model flips to its downloaded state.
          setPolling(false);
          reload();
        }
      } catch {
        // A transient status read failure should not tear the view down; the next tick retries.
      }
    }, STATUS_POLL_MS);

    return () => clearInterval(timer);
  }, [polling]);

  const savePreference = async (key, value) => {
    // The checkbox is uncontrolled (defaultChecked, re-keyed on reload) so the DOM owns its state: the
    // user's click sticks immediately and the write happens in the background. A failure surfaces a toast;
    // the box keeps the attempted value until the next reload re-reads the server state, rather than being
    // yanked back under the pointer (which would also fight the box's own checked state).
    try {
      const next = await http.put("/api/models/preferences", { [key]: value });
      setPreferences(next);
      showToast(strings.modelManager.prefsSaved);
    } catch (error) {
      showToast(messageFor(error, strings.modelManager.prefsFailed), "error");
    }
  };

  const selectModel = async (model) => {
    try {
      await http.put("/api/models/preferences", { selected_model: model.key });
      showToast(strings.modelManager.prefsSaved);
      reload();
    } catch (error) {
      showToast(messageFor(error, strings.modelManager.prefsFailed), "error");
    }
  };

  const downloadModel = async (model) => {
    try {
      await http.post("/api/models/download", { key: model.key });
      showToast(strings.modelManager.downloadStarted);
      setStatus({ download_all_active: false, downloading_model: model.key, progress: "Downloading..." });
      setPolling(true);
    } catch (error) {
      showToast(messageFor(error, strings.modelManager.downloadFailed), "error");
    }
  };

  const downloadAll = async () => {
    try {
      await http.post("/api/models/download_all");
      showToast(strings.modelManager.downloadAllStarted);
      setStatus({ download_all_active: true, downloading_model: null, progress: "Downloading..." });
      setPolling(true);
    } catch (error) {
      showToast(messageFor(error, strings.modelManager.downloadFailed), "error");
    }
  };

  const cancelDownload = async () => {
    try {
      await http.post("/api/models/cancel");
      showToast(strings.modelManager.downloadCancelled);
      setStatus({ download_all_active: false, downloading_model: null, progress: null });
      setPolling(false);
    } catch (error) {
      showToast(messageFor(error, strings.modelManager.downloadFailed), "error");
    }
  };

  const refresh = async () => {
    try {
      const catalog = await http.post("/api/models/refresh_manifest");
      setModels(catalog);
      // Clear the catalog-error/loading state so a refresh that recovers from a failed initial load shows
      // the freshly-fetched list instead of leaving renderMessage stuck on the error text.
      setFailed(false);
      setLoading(false);
      showToast(strings.modelManager.refreshed);
    } catch (error) {
      showToast(messageFor(error, strings.modelManager.refreshFailed), "error");
    }
  };

  const removeModel = async (model) => {
    setPendingDelete(null);
    try {
      await http.post("/api/models/delete", { key: model.key });
      showToast(strings.modelManager.deleted);
      reload();
    } catch (error) {
      showToast(messageFor(error, strings.modelManager.deleteFailed), "error");
    }
  };

  const message = renderMessage(failed, loading, models.length);
  const hasUndownloaded = models.some((model) => !model.installed);
  const active = isActive(status);

  return html`
    <section class="model-manager">
      <header class="model-manager-header">
        <h1 class="model-manager-title">${strings.modelManager.title}</h1>
        <div class="model-manager-tools">
          ${hasUndownloaded &&
          html`<button class="btn btn-primary" onClick=${downloadAll}>
            <${Icon} name="download" /> <span>${strings.modelManager.downloadAll}</span>
          </button>`}
          <button class="btn" onClick=${refresh}><${Icon} name="refresh" /> <span>${strings.modelManager.refresh}</span></button>
        </div>
      </header>

      ${active &&
      html`<div class="model-manager-progress" role="status">
        <span class="model-progress-text">${status.progress || strings.modelManager.downloadStarted}</span>
        <button class="btn btn-ghost model-cancel" onClick=${cancelDownload}>${strings.modelManager.cancelDownload}</button>
      </div>`}
      ${preferences &&
      html`<div class="model-prefs" key=${reloadKey}>
        <label class="model-pref">
          <input
            type="checkbox"
            defaultChecked=${preferences.AutomaticallyDownloadModels}
            onChange=${(event) => savePreference("AutomaticallyDownloadModels", event.target.checked)}
          />
          <span>${strings.modelManager.autoDownload}</span>
        </label>
        <label class="model-pref">
          <input
            type="checkbox"
            defaultChecked=${preferences.ModelRandomizer}
            onChange=${(event) => savePreference("ModelRandomizer", event.target.checked)}
          />
          <span>${strings.modelManager.modelRandomizer}</span>
        </label>
      </div>`}
      ${message
        ? html`
            <p class="model-manager-message">${message}</p>
            ${failed &&
            html`<button class="btn btn-primary model-manager-retry" onClick=${reload}>${strings.modelManager.retry}</button>`}
          `
        : html`
            <ul class="model-list">
              ${models.map(
                (model) =>
                  html`<${ModelRow}
                    key=${model.key}
                    model=${model}
                    onDownload=${downloadModel}
                    onSelect=${selectModel}
                    onDelete=${setPendingDelete}
                  />`,
              )}
            </ul>
          `}
      ${pendingDelete &&
      html`<${Modal}
        title=${strings.modelManager.deleteConfirmTitle}
        message=${strings.modelManager.deleteConfirm(pendingDelete.name)}
        confirmLabel=${strings.common.delete}
        danger
        onConfirm=${() => removeModel(pendingDelete)}
        onCancel=${() => setPendingDelete(null)}
      />`}
    </section>
  `;
}

function renderMessage(failed, loading, count) {
  if (failed) {
    return strings.modelManager.error;
  }

  if (loading) {
    return strings.modelManager.loading;
  }

  if (count === 0) {
    return strings.modelManager.empty;
  }

  return null;
}
