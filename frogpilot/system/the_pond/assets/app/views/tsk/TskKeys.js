import { useEffect, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

const KEY_VALUE_LENGTH = 32;

// Mirror the device-true validation the server enforces (tsk_service validate_name/validate_value): a
// name must be non-empty with no internal whitespace, and a value must be exactly 32 hex characters. The
// server re-validates, so this only disables Save early to give immediate feedback.
function nameIsValid(name) {
  return name.length > 0 && !/\s/.test(name);
}

function valueIsValid(value) {
  return value.length === KEY_VALUE_LENGTH && /^[0-9a-fA-F]+$/.test(value);
}

export function TskKeys() {
  const [keys, setKeys] = useState([]);
  const [selectedName, setSelectedName] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);

    const controller = new AbortController();

    http
      .get("/api/tsk_keys", { signal: controller.signal })
      .then((loaded) => {
        setKeys(loaded);
        setLoading(false);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }

        showToast(messageFor(error, strings.tsk.loadError), "error");
        setKeys([]);
        setLoading(false);
      });

    // Abort the in-flight load on unmount so a resolved fetch never sets state on an unmounted view and a
    // navigated-away request does not linger (CONVENTIONS §11).
    return () => controller.abort();
  }, []);

  const selectKey = (chosenName) => {
    setSelectedName(chosenName);
    const saved = keys.find((key) => key.name === chosenName);
    setName(saved ? saved.name : "");
    setValue("");
  };

  // A name that matches a different saved key would create a second entry under that name on the server;
  // surface the duplicate up front and block Save, mirroring the old isDuplicateName guard.
  const duplicateName = keys.some((key) => key.name === name && key.name !== selectedName);
  const canSave = nameIsValid(name) && valueIsValid(value) && !duplicateName;
  const canActOnSelected = selectedName.length > 0 && Boolean(keys.find((key) => key.name === selectedName));

  const save = async () => {
    if (!canSave) {
      return;
    }

    try {
      const updated = await http.post("/api/tsk_keys", { name, value });

      setKeys(updated);
      setSelectedName(name);
      setValue("");
      showToast(strings.tsk.saveSuccess);
    } catch (error) {
      showToast(messageFor(error, strings.tsk.saveError), "error");
    }
  };

  const remove = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) {
      return;
    }

    try {
      const remaining = await http.del(`/api/tsk_keys?name=${encodeURIComponent(target)}`);

      setKeys(remaining);
      setSelectedName("");
      setName("");
      setValue("");
      showToast(strings.tsk.deleteSuccess);
    } catch (error) {
      showToast(messageFor(error, strings.tsk.deleteError), "error");
    }
  };

  const apply = async () => {
    const saved = keys.find((key) => key.name === selectedName);
    if (!saved) {
      return;
    }

    try {
      await http.post("/api/tsk_key_set", { name: saved.name });

      showToast(strings.tsk.applySuccess);
    } catch (error) {
      showToast(messageFor(error, strings.tsk.applyError), "error");
    }
  };

  return html`
    <section class="tsk">
      <header class="tsk-header">
        <h1 class="tsk-title">${strings.tsk.title}</h1>
      </header>

      ${!loading && keys.length === 0 && html`<p class="tsk-message">${strings.tsk.emptyState}</p>`}

      <div class="tsk-panel">
        <label class="tsk-field">
          <span class="tsk-label">${strings.tsk.selectLabel}</span>
          <select
            class="tsk-select"
            value=${selectedName}
            disabled=${keys.length === 0}
            onChange=${(event) => selectKey(event.target.value)}
          >
            <option value="">${strings.tsk.selectPlaceholder}</option>
            ${keys.map((key) => html`<option key=${key.name} value=${key.name}>${key.name}</option>`)}
          </select>
        </label>

        <label class="tsk-field">
          <span class="tsk-label">${strings.tsk.nameLabel}</span>
          <input
            class="tsk-input"
            value=${name}
            autocomplete="off"
            placeholder=${strings.tsk.keyNamePlaceholder}
            onInput=${(event) => setName(event.target.value.replace(/^\s+/, ""))}
          />
          ${duplicateName && html`<span class="tsk-error" role="alert">${strings.tsk.duplicateName}</span>`}
        </label>

        <label class="tsk-field">
          <span class="tsk-label">${strings.tsk.valueLabel}</span>
          <input
            class="tsk-input"
            value=${value}
            autocomplete="off"
            placeholder=${strings.tsk.keyValuePlaceholder}
            onInput=${(event) => setValue(event.target.value.replace(/\s+/g, ""))}
          />
        </label>

        <div class="tsk-actions">
          <button class="btn btn-primary" disabled=${!canSave} onClick=${save}>
            <span>${strings.tsk.saveButton}</span>
          </button>
          <button class="btn" disabled=${!canActOnSelected} onClick=${apply}>
            <${Icon} name="key" /> <span>${strings.tsk.applyButton}</span>
          </button>
          <button class="btn btn-danger" disabled=${!canActOnSelected} onClick=${() => setPendingDelete(selectedName)}>
            <${Icon} name="trash" /> <span>${strings.tsk.deleteButton}</span>
          </button>
        </div>
      </div>

      ${pendingDelete &&
      html`<${Modal}
        title=${strings.tsk.deleteConfirmTitle}
        message=${strings.tsk.deleteConfirmBody}
        confirmLabel=${strings.tsk.deleteConfirmConfirm}
        danger
        onConfirm=${remove}
        onCancel=${() => setPendingDelete(null)}
      />`}
    </section>
  `;
}
