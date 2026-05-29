import { useEffect, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

// Per-key validation mirrored from the backend KEY_SPECS so the Save button can disable until the prefixed
// value is long enough, instead of round-tripping a doomed request (navigation_service.py KEY_SPECS,
// navigation_keys.js:67-70). The backend re-validates, so this is UX, not the security boundary.
const KEY_FIELDS = [
  {
    field: "amap1",
    group: "amap",
    label: strings.navigation.amapKey1,
    minLength: 39,
    prefix: "",
    stateKey: "amap1Key",
    statusKey: "hasAmap1Key",
  },
  {
    field: "amap2",
    group: "amap",
    label: strings.navigation.amapKey2,
    minLength: 39,
    prefix: "",
    stateKey: "amap2Key",
    statusKey: "hasAmap2Key",
  },
  {
    field: "public",
    group: "mapbox",
    label: strings.navigation.mapboxKeyPublic,
    minLength: 80,
    prefix: "pk.",
    stateKey: "mapboxPublic",
    statusKey: "mapboxPublic",
  },
  {
    field: "secret",
    group: "mapbox",
    label: strings.navigation.mapboxKeySecret,
    minLength: 80,
    prefix: "sk.",
    stateKey: "mapboxSecret",
    statusKey: "hasMapboxSecret",
  },
];

const MAPBOX_FIELDS = KEY_FIELDS.filter((spec) => spec.group === "mapbox");
const AMAP_FIELDS = KEY_FIELDS.filter((spec) => spec.group === "amap");

function withPrefix(value, prefix) {
  if (!value || !prefix) {
    return value;
  }

  return value.startsWith(prefix) ? value : `${prefix}${value}`;
}

function maskKey(value) {
  if (!value) {
    return "";
  }

  const prefix = ["pk.", "sk."].find((candidate) => value.startsWith(candidate)) || "";
  return prefix + "x".repeat(value.length - prefix.length);
}

function savedFromData(spec, data) {
  return spec.field === "public" ? Boolean(data.mapboxPublic) : Boolean(data[spec.statusKey]);
}

function savedDisplayValue(spec, value = "") {
  if (spec.field === "public") {
    return value;
  }

  return `${spec.prefix}${"x".repeat(spec.minLength - spec.prefix.length)}`;
}

function valuesFromNavigation(data) {
  return Object.fromEntries(
    KEY_FIELDS.map((spec) => [spec.stateKey, savedFromData(spec, data) ? savedDisplayValue(spec, data[spec.stateKey]) : ""]),
  );
}

function savedFromNavigation(data) {
  return Object.fromEntries(KEY_FIELDS.map((spec) => [spec.stateKey, savedFromData(spec, data)]));
}

// Pick the help screenshot that matches the current Mapbox key state, mirroring the old panel
// (navigation_keys.js:258-268, navigation_settings.cc:392-409). A cache-busting version is appended so a
// freshly saved/deleted key reloads the image.
function helpImageName(savedPublic, savedSecret) {
  if (savedPublic && savedSecret) {
    return "both_keys_set";
  }
  if (savedPublic) {
    return "public_key_set";
  }

  return "no_keys_set";
}

export function NavKeys() {
  const [values, setValues] = useState({ amap1Key: "", amap2Key: "", mapboxPublic: "", mapboxSecret: "" });
  const [saved, setSaved] = useState({ amap1Key: false, amap2Key: false, mapboxPublic: false, mapboxSecret: false });
  const [editing, setEditing] = useState({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [pendingDelete, setPendingDelete] = useState(null);

  useEffect(() => {
    let active = true;
    http
      .get("/api/navigation_keys")
      .then((data) => {
        if (!active) {
          return;
        }

        setValues(valuesFromNavigation(data));
        setSaved(savedFromNavigation(data));
        setLoading(false);
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
  }, []);

  const onInput = (spec, value) => {
    setValues((current) => ({ ...current, [spec.stateKey]: value }));
  };

  // Tapping a saved (masked) field clears it for re-entry, the same affordance the old keydown handler
  // gave (navigation_keys.js:232-239).
  const beginEdit = (spec) => {
    if (saved[spec.stateKey] && !editing[spec.stateKey]) {
      setEditing((current) => ({ ...current, [spec.stateKey]: true }));
      setSaved((current) => ({ ...current, [spec.stateKey]: false }));
      setValues((current) => ({ ...current, [spec.stateKey]: "" }));
    }
  };

  const canSave = (spec) => {
    if (saved[spec.stateKey]) {
      return false;
    }

    const value = (values[spec.stateKey] || "").trim();
    return Boolean(value) && withPrefix(value, spec.prefix).length >= spec.minLength;
  };

  const save = async (spec) => {
    const value = withPrefix((values[spec.stateKey] || "").trim(), spec.prefix);
    try {
      await http.post("/api/navigation_key", { [spec.field]: value });
      setValues((current) => ({ ...current, [spec.stateKey]: savedDisplayValue(spec, value) }));
      setSaved((current) => ({ ...current, [spec.stateKey]: true }));
      setEditing((current) => ({ ...current, [spec.stateKey]: false }));
      if (spec.group === "mapbox") {
        setImageVersion((version) => version + 1);
      }

      showToast(strings.navigation.keySaved);
    } catch (error) {
      const message = messageFor(error, strings.navigation.keySaveFailed);
      // Clear the field so the rejected value is not left masked-as-saved.
      setValues((current) => ({ ...current, [spec.stateKey]: "" }));
      setEditing((current) => ({ ...current, [spec.stateKey]: true }));
      showToast(message, "error");
    }
  };

  const remove = async (spec) => {
    setPendingDelete(null);
    try {
      await http.del(`/api/navigation_key?type=${spec.field}`);
      setValues((current) => ({ ...current, [spec.stateKey]: "" }));
      setSaved((current) => ({ ...current, [spec.stateKey]: false }));
      setEditing((current) => ({ ...current, [spec.stateKey]: false }));
      if (spec.group === "mapbox") {
        setImageVersion((version) => version + 1);
      }

      showToast(strings.navigation.keyDeleted);
    } catch (error) {
      showToast(messageFor(error, strings.navigation.keyDeleteFailed), "error");
    }
  };

  if (loading) {
    return html`<section class="navkeys"><p class="navkeys-message">${strings.navigation.loading}</p></section>`;
  }

  if (failed) {
    return html`<section class="navkeys"><p class="navkeys-message">${strings.navigation.loadFailed}</p></section>`;
  }

  const helpName = helpImageName(saved.mapboxPublic, saved.mapboxSecret);

  return html`
    <section class="navkeys">
      <div class="navkeys-group">
        <h2 class="navkeys-title">${strings.navigation.mapboxKeysTitle}</h2>
        <button
          class="icon-btn"
          aria-label=${strings.navigation.mapboxHelp}
          aria-pressed=${showHelp}
          onClick=${() => setShowHelp((value) => !value)}
        >
          <${Icon} name="key" />
        </button>
        ${MAPBOX_FIELDS.map(
          (spec) =>
            html`<${KeyRow}
              key=${spec.field}
              spec=${spec}
              value=${values[spec.stateKey]}
              saved=${saved[spec.stateKey]}
              canSave=${canSave(spec)}
              onInput=${onInput}
              onFocus=${beginEdit}
              onSave=${save}
              onDelete=${setPendingDelete}
            />`,
        )}
        ${showHelp &&
        html`<div class="navkeys-help">
          <img
            class="navkeys-help-img"
            alt=${strings.navigation.mapboxHelp}
            src=${`/mapbox-help/${helpName}.png?v=${imageVersion}`}
          />
        </div>`}
      </div>

      <div class="navkeys-group">
        <h2 class="navkeys-title">${strings.navigation.amapKeysTitle}</h2>
        ${AMAP_FIELDS.map(
          (spec) =>
            html`<${KeyRow}
              key=${spec.field}
              spec=${spec}
              value=${values[spec.stateKey]}
              saved=${saved[spec.stateKey]}
              canSave=${canSave(spec)}
              onInput=${onInput}
              onFocus=${beginEdit}
              onSave=${save}
              onDelete=${setPendingDelete}
            />`,
        )}
      </div>

      ${pendingDelete &&
      html`<${Modal}
        title=${strings.navigation.keyDeleteConfirmTitle}
        message=${strings.navigation.keyDeleteConfirm(pendingDelete.label)}
        confirmLabel=${strings.common.delete}
        danger
        onConfirm=${() => remove(pendingDelete)}
        onCancel=${() => setPendingDelete(null)}
      />`}
    </section>
  `;
}

function KeyRow({ spec, value, saved, canSave, onInput, onFocus, onSave, onDelete }) {
  const inputId = `navkey-${spec.field}`;
  return html`
    <div class="navkeys-field">
      <label class="navkeys-label" for=${inputId}>${spec.label}</label>
      <div class="navkeys-row">
        <input
          class="navkeys-input"
          id=${inputId}
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder=${`${spec.prefix}xxxxxx…`}
          value=${saved ? maskKey(value) : value}
          onFocus=${() => onFocus(spec)}
          onInput=${(event) => onInput(spec, event.target.value)}
        />
        ${saved
          ? html`<button class="btn btn-danger" onClick=${() => onDelete(spec)}>
              <${Icon} name="trash" /> <span>${strings.common.delete}</span>
            </button>`
          : html`<button class="btn btn-primary" disabled=${!canSave} onClick=${() => onSave(spec)}>
              ${strings.common.save}
            </button>`}
      </div>
    </div>
  `;
}
