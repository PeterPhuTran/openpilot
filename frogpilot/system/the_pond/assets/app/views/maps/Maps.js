import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { formatBytes } from "../../lib/format.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

const STATUS_POLL_MS = 3000;

const SCHEDULE_OPTIONS = [
  { label: strings.maps.scheduleManually, value: 0 },
  { label: strings.maps.scheduleWeekly, value: 1 },
  { label: strings.maps.scheduleMonthly, value: 2 },
];

const EMPTY_SELECTION = { nations: [], states: [] };

// The picker tab maps to the catalog group and the selection field it writes. "nations" is the
// selection key the backend stores for the Countries catalog (matching MapsSelected on disk).
const TABS = [
  { catalog: "countries", field: "nations", label: strings.maps.countriesTab },
  { catalog: "states", field: "states", label: strings.maps.statesTab },
];

function isDownloading(status) {
  return Boolean(status && status.progress && status.progress.running);
}

function progressText(progress) {
  if (progress.totalFiles == null || progress.downloadedFiles == null) {
    return strings.maps.progressLabel;
  }

  return strings.maps.progress(progress.downloadedFiles, progress.totalFiles);
}

function CatalogGroup({ group, selected, onToggle }) {
  return html`
    <div class="maps-group">
      <h3 class="maps-group-title">${group.label}</h3>
      <div class="maps-options">
        ${group.codes.map(
          (option) => html`
            <label class="maps-option" key=${option.code}>
              <input
                type="checkbox"
                class="maps-option-check"
                checked=${selected.includes(option.code)}
                onChange=${() => onToggle(option.code)}
              />
              <span class="maps-option-name">${option.name}</span>
            </label>
          `,
        )}
      </div>
    </div>
  `;
}

export function Maps() {
  const [catalog, setCatalog] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [activeTab, setActiveTab] = useState("countries");
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // The poll callback is recreated on every render (it reads current state), but the mount-only effect
  // that schedules it must always call the latest version — so it is read through a ref (§3.4, §11).
  const pollRef = useRef(null);

  const downloading = isDownloading(status);
  const selection = status ? status.selection : EMPTY_SELECTION;
  const hasSelection = selection.nations.length > 0 || selection.states.length > 0;

  const reload = () => setReloadKey((key) => key + 1);

  // Initial load: the catalog is static so it is fetched once per reload; the status is fetched here and
  // then refreshed by the poll below so progress and the downloaded/idle state stay live.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);

    Promise.all([http.get("/api/maps/catalog"), http.get("/api/maps/status")])
      .then(([catalogData, statusData]) => {
        if (active) {
          setCatalog(catalogData);
          setStatus(statusData);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  // Refresh status on an interval so an in-flight download's progress advances and a finished/cancelled
  // download flips the button back without a manual reload. Read-only; failures are ignored so a single
  // missed poll never tears down the view (the next tick recovers).
  const poll = async () => {
    try {
      const next = await http.get("/api/maps/status");
      setStatus(next);
    } catch {
      // A transient status read failure is non-fatal here; the listing already loaded and the next poll
      // recovers. The initial-load effect owns the hard error state.
    }
  };
  pollRef.current = poll;

  // Mount-only: the recursive timer is scheduled once and always invokes the latest poll via the ref, so
  // a re-render (status updating, a tab switch) cannot stack a second interval. Cleared on unmount (§11).
  useEffect(() => {
    let active = true;
    let timer;

    const tick = async () => {
      await pollRef.current();
      if (active) {
        timer = setTimeout(tick, STATUS_POLL_MS);
      }
    };

    timer = setTimeout(tick, STATUS_POLL_MS);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  // Apply the toggle optimistically so the checkbox reflects intent immediately (a controlled box must not
  // wait on the round-trip to flip), then reconcile with the server's echoed selection — or roll back to the
  // previous selection on failure so a rejected code never stays checked.
  const persistSelection = async (previous, next) => {
    setSaving(true);
    setStatus((current) => (current ? { ...current, selection: next } : current));

    try {
      const saved = await http.post("/api/maps/selection", next);
      setStatus((current) => (current ? { ...current, selection: saved } : current));
      showToast(strings.maps.selectionSaved);
    } catch (error) {
      setStatus((current) => (current ? { ...current, selection: previous } : current));
      showToast(messageFor(error, strings.maps.selectionError), "error");
    } finally {
      setSaving(false);
    }
  };

  const toggleCode = (field, code) => {
    const current = selection[field];
    const nextField = current.includes(code) ? current.filter((value) => value !== code) : [...current, code];
    persistSelection(selection, { ...selection, [field]: nextField });
  };

  const changeSchedule = async (value) => {
    const previous = status ? status.schedule : 0;
    setStatus((current) => (current ? { ...current, schedule: value } : current));

    try {
      await http.post("/api/maps/schedule", { schedule: value });
      showToast(strings.maps.scheduleSaved);
    } catch (error) {
      setStatus((current) => (current ? { ...current, schedule: previous } : current));
      showToast(messageFor(error, strings.maps.scheduleError), "error");
    }
  };

  const startDownload = async () => {
    if (!hasSelection) {
      showToast(strings.maps.emptySelection, "error");
      return;
    }

    try {
      await http.post("/api/maps/download");
      showToast(strings.maps.downloadStarted);
      poll();
    } catch (error) {
      showToast(messageFor(error, strings.maps.downloadError), "error");
    }
  };

  const cancelDownload = async () => {
    setConfirmCancel(false);
    try {
      await http.post("/api/maps/cancel");
      showToast(strings.maps.cancelled);
      poll();
    } catch (error) {
      showToast(messageFor(error, strings.maps.cancelError), "error");
    }
  };

  const removeMaps = async () => {
    setConfirmRemove(false);
    try {
      await http.post("/api/maps/remove");
      showToast(strings.maps.removed);
      poll();
    } catch (error) {
      showToast(messageFor(error, strings.maps.removeError), "error");
    }
  };

  if (loading) {
    return html`
      <section class="maps">
        <h1 class="maps-title">${strings.maps.title}</h1>
        <p class="maps-message">${strings.maps.loading}</p>
      </section>
    `;
  }

  if (failed || !catalog || !status) {
    return html`
      <section class="maps">
        <h1 class="maps-title">${strings.maps.title}</h1>
        <p class="maps-message">${strings.maps.loadError}</p>
        <div class="maps-actions">
          <button class="btn" onClick=${reload}>${strings.maps.retry}</button>
        </div>
      </section>
    `;
  }

  const tab = TABS.find((entry) => entry.catalog === activeTab) || TABS[0];
  const groups = catalog[tab.catalog] || [];

  return html`
    <section class="maps">
      <header class="maps-header">
        <h1 class="maps-title">${strings.maps.title}</h1>
        <p class="maps-text">${strings.maps.description}</p>
      </header>

      <div class="maps-status" role="group" aria-label=${strings.maps.title}>
        <div class="maps-status-item">
          <span class="maps-status-label">${strings.maps.storageUsed}</span>
          <span class="maps-status-value">${formatBytes(status.sizeBytes)}</span>
        </div>
        <div class="maps-status-item">
          <span class="maps-status-label">${strings.maps.lastUpdated}</span>
          <span class="maps-status-value">${status.lastUpdated || strings.maps.never}</span>
        </div>
      </div>

      ${downloading &&
      html`<div class="maps-progress" role="status">
        <${Icon} name="download" />
        <span class="maps-progress-text">${progressText(status.progress)}</span>
      </div>`}

      <div class="maps-controls">
        <label class="maps-schedule">
          <span class="maps-schedule-label">${strings.maps.scheduleLabel}</span>
          <select
            class="maps-select"
            value=${String(status.schedule)}
            onChange=${(event) => changeSchedule(Number(event.target.value))}
          >
            ${SCHEDULE_OPTIONS.map(
              (option) => html`<option key=${option.value} value=${String(option.value)}>${option.label}</option>`,
            )}
          </select>
        </label>

        <div class="maps-buttons">
          ${downloading
            ? html`<button class="btn btn-danger maps-cancel" onClick=${() => setConfirmCancel(true)}>
                <${Icon} name="close" /> <span>${strings.maps.cancelButton}</span>
              </button>`
            : html`<button class="btn btn-primary maps-download" onClick=${startDownload} disabled=${!hasSelection || saving}>
                <${Icon} name="download" /> <span>${strings.maps.downloadButton}</span>
              </button>`}
          <button class="btn btn-danger maps-remove" onClick=${() => setConfirmRemove(true)} disabled=${!status.downloaded}>
            <${Icon} name="trash" /> <span>${strings.maps.removeButton}</span>
          </button>
        </div>
      </div>

      <div class="maps-tabs" role="tablist" aria-label=${strings.maps.title}>
        ${TABS.map(
          (entry) => html`
            <button
              key=${entry.catalog}
              class=${`btn maps-tab ${activeTab === entry.catalog ? "is-active" : ""}`}
              role="tab"
              aria-selected=${activeTab === entry.catalog ? "true" : "false"}
              onClick=${() => setActiveTab(entry.catalog)}
            >
              ${entry.label}
            </button>
          `,
        )}
      </div>

      <div class="maps-catalog" role="tabpanel">
        ${groups.map(
          (group) =>
            html`<${CatalogGroup}
              key=${group.label}
              group=${group}
              selected=${selection[tab.field]}
              onToggle=${(code) => toggleCode(tab.field, code)}
            />`,
        )}
      </div>

      ${confirmCancel &&
      html`<${Modal}
        title=${strings.maps.cancelConfirmTitle}
        message=${strings.maps.cancelConfirmBody}
        confirmLabel=${strings.maps.cancelButton}
        cancelLabel=${strings.maps.keepDownloading}
        danger
        onConfirm=${cancelDownload}
        onCancel=${() => setConfirmCancel(false)}
      />`}
      ${confirmRemove &&
      html`<${Modal}
        title=${strings.maps.removeConfirmTitle}
        message=${strings.maps.removeConfirmBody}
        confirmLabel=${strings.maps.removeButton}
        danger
        onConfirm=${removeMaps}
        onCancel=${() => setConfirmRemove(false)}
      />`}
    </section>
  `;
}
