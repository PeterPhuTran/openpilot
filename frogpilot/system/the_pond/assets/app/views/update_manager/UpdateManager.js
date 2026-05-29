import { useEffect, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

// The updater publishes its progress as a string; anything other than "idle" (or an as-yet-unwritten
// empty value, treated as idle by the backend) means a check/download is running and the destructive
// actions must stay disabled. Mirrors the service's require_idle_updater() gate.
function updaterBusy(status) {
  const state = status?.updaterState ?? "";
  return state !== "" && state !== "idle";
}

function StatusField({ label, value }) {
  return html`
    <div class="update-field">
      <dt class="update-label">${label}</dt>
      <dd class="update-value">${value || strings.updateManager.unknown}</dd>
    </div>
  `;
}

function StatusPanel({ status, branchCurrent }) {
  const busy = updaterBusy(status);
  const indicator = status?.updateAvailable
    ? strings.updateManager.updateAvailable
    : status?.fetchAvailable
      ? strings.updateManager.fetchAvailable
      : strings.updateManager.upToDate;

  return html`
    <section class="update-panel">
      <dl class="update-grid">
        <${StatusField} label=${strings.updateManager.currentBranchLabel} value=${branchCurrent || status?.currentBranch} />
        <${StatusField} label=${strings.updateManager.currentVersionLabel} value=${status?.version} />
        <${StatusField} label=${strings.updateManager.commitLabel} value=${status?.commitHash} />
        <${StatusField} label=${strings.updateManager.commitDateLabel} value=${status?.commitDate} />
      </dl>
      <p class=${`update-indicator ${status?.updateAvailable || status?.fetchAvailable ? "is-available" : ""}`}>${indicator}</p>
      ${busy && html`<p class="update-busy" role="status">${strings.updateManager.busy(status.updaterState)}</p>`}
    </section>
  `;
}

export function UpdateManager() {
  const [status, setStatus] = useState(null);
  const [branches, setBranches] = useState([]);
  const [branchCurrent, setBranchCurrent] = useState("");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [inFlight, setInFlight] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);

  const reload = () => setReloadKey((key) => key + 1);

  // The effect re-runs on reloadKey (Retry / Refresh); each run owns a fresh AbortController whose abort()
  // in the cleanup tears the two in-flight fetches down on unmount/reload, and the mounted ref drops a
  // late resolve so the cleanup never sets state on a dead view (REWRITE_PLAN §3.4, §11). No stream,
  // interval, listener, <video>, or objectURL is opened, so this is the only teardown surface.
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    setLoading(true);
    setFailed(false);

    const load = async () => {
      try {
        const [statusResponse, branchResponse] = await Promise.all([
          http.get("/api/update/fast/status", { signal: controller.signal }),
          http.get("/api/update/branches", { signal: controller.signal }),
        ]);

        if (!mounted) {
          return;
        }

        const current = branchResponse.current ?? statusResponse.currentBranch ?? "";
        const switchable = (branchResponse.branches ?? []).filter((branch) => branch !== current);

        setStatus(statusResponse);
        setBranchCurrent(current);
        setBranches(switchable);
        setSelectedBranch((previous) => (switchable.includes(previous) ? previous : (switchable[0] ?? "")));
        setLoading(false);
      } catch (error) {
        // An aborted fetch on unmount/reload is expected teardown, not a load failure.
        if (mounted && error.name !== "AbortError") {
          setFailed(true);
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [reloadKey]);

  const startUpdate = async () => {
    setConfirmUpdate(false);
    setInFlight(true);

    try {
      await http.post("/api/update/fast");

      showToast(strings.updateManager.updateStarted);
      reload();
    } catch (error) {
      showToast(messageFor(error, strings.updateManager.updateError), "error");
      setInFlight(false);
    }
  };

  const switchBranch = async () => {
    setConfirmSwitch(false);
    setInFlight(true);

    try {
      await http.post("/api/update/branch", { branch: selectedBranch });

      showToast(strings.updateManager.branchSwitchStarted);
      reload();
    } catch (error) {
      showToast(messageFor(error, strings.updateManager.branchSwitchError), "error");
      setInFlight(false);
    }
  };

  if (loading) {
    return html`
      <section class="update-manager">
        <header class="update-header"><h1 class="update-title">${strings.updateManager.title}</h1></header>
        <p class="update-message">${strings.updateManager.loading}</p>
      </section>
    `;
  }

  if (failed) {
    return html`
      <section class="update-manager">
        <header class="update-header"><h1 class="update-title">${strings.updateManager.title}</h1></header>
        <p class="update-message">${strings.updateManager.loadError}</p>
        <div class="update-actions">
          <button class="btn btn-primary" onClick=${reload}>${strings.updateManager.retry}</button>
        </div>
      </section>
    `;
  }

  const busy = updaterBusy(status);
  const actionsDisabled = inFlight || busy;
  const hasBranches = branches.length > 0;

  return html`
    <section class="update-manager">
      <header class="update-header">
        <h1 class="update-title">${strings.updateManager.title}</h1>
        <button class="icon-btn" aria-label=${strings.updateManager.refresh} onClick=${reload} disabled=${inFlight}>
          <${Icon} name="refresh" />
        </button>
      </header>

      <${StatusPanel} status=${status} branchCurrent=${branchCurrent} />

      <section class="update-panel">
        <h2 class="update-card-title">${strings.updateManager.updateHeading}</h2>
        <p class="update-text">${strings.updateManager.updateDescription}</p>
        <button class="btn btn-danger" onClick=${() => setConfirmUpdate(true)} disabled=${actionsDisabled}>
          <${Icon} name="refresh" /> <span>${strings.updateManager.updateButton}</span>
        </button>
      </section>

      <section class="update-panel">
        <h2 class="update-card-title">${strings.updateManager.switchHeading}</h2>
        ${hasBranches
          ? html`
              <p class="update-text">${strings.updateManager.switchDescription}</p>
              <div class="update-switch">
                <label class="update-switch-label" for="update-branch-select">${strings.updateManager.selectBranchLabel}</label>
                <select
                  id="update-branch-select"
                  class="update-select"
                  value=${selectedBranch}
                  onChange=${(event) => setSelectedBranch(event.target.value)}
                  disabled=${actionsDisabled}
                >
                  ${branches.map((branch) => html`<option key=${branch} value=${branch}>${branch}</option>`)}
                </select>
                <button
                  class="btn btn-danger"
                  onClick=${() => setConfirmSwitch(true)}
                  disabled=${actionsDisabled || !selectedBranch}
                >
                  <${Icon} name="refresh" /> <span>${strings.updateManager.switchBranchButton}</span>
                </button>
              </div>
            `
          : html`<p class="update-text update-hint">${strings.updateManager.noBranches}</p>`}
      </section>

      ${confirmUpdate &&
      html`<${Modal}
        title=${strings.updateManager.updateButton}
        message=${strings.updateManager.updateConfirm}
        confirmLabel=${strings.updateManager.updateButton}
        danger
        onConfirm=${startUpdate}
        onCancel=${() => setConfirmUpdate(false)}
      />`}
      ${confirmSwitch &&
      html`<${Modal}
        title=${strings.updateManager.branchSwitchTitle}
        message=${strings.updateManager.branchSwitchConfirm(selectedBranch)}
        confirmLabel=${strings.updateManager.switchBranchButton}
        danger
        onConfirm=${switchBranch}
        onCancel=${() => setConfirmSwitch(false)}
      />`}
    </section>
  `;
}
