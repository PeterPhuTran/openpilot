import { html } from "../../lib/html.js";
import { strings } from "../../lib/strings.js";
import {
  actionOwnerReason,
  asArray,
  clamp,
  isParamTruthy,
  joinIds,
  numericFromValue,
  numericLabel,
  normalizeStep,
  plainText,
  safeId,
  settingStatusClass,
  unsupportedMessage,
  valueMapEntries,
} from "./SettingsUtils.js";

function SettingSwitch({ toggle, value, onChange, disabled, describedBy }) {
  const on = value === "1";
  return html`
    <button
      type="button"
      class=${`setting-switch ${on ? "is-on" : ""}`}
      role="switch"
      aria-label=${toggle.title}
      aria-checked=${on ? "true" : "false"}
      aria-describedby=${describedBy}
      disabled=${disabled}
      onClick=${() => onChange(!on)}
    >
      <span class="setting-switch-track"><span class="setting-switch-thumb"></span></span>
      <span class="setting-switch-label">${on ? strings.settings.on : strings.settings.off}</span>
    </button>
  `;
}

function SettingNumeric({ toggle, value, onChange, disabled, describedBy }) {
  const min = Number.isFinite(toggle.min_value) ? toggle.min_value : 0;
  const max = Number.isFinite(toggle.max_value) ? toggle.max_value : 100;
  const step = Number.isFinite(toggle.step) ? toggle.step : 1;
  const safe = numericFromValue(value, min);
  const rangeValue = clamp(safe, min, max);
  const sentinelEntries = valueMapEntries(toggle);
  const sentinelValues = new Set(sentinelEntries.map((entry) => entry.value));
  const metaId = `${safeId(toggle.param)}-numeric-meta`;
  const controlDescription = joinIds(describedBy, metaId);
  const commit = (next) => {
    const numeric = numericFromValue(next, safe);
    const stepped = normalizeStep(numeric, step);
    const bounded = sentinelValues.has(numeric) ? numeric : normalizeStep(clamp(stepped, min, max), step);
    onChange(bounded);
  };
  const decrease = () => commit(normalizeStep(clamp(safe - step, min, max), step));
  const increase = () => commit(normalizeStep(clamp(safe + step, min, max), step));

  return html`
    <div class="setting-numeric">
      <div class="setting-numeric-primary">
        <button
          type="button"
          class="btn setting-stepper"
          aria-label=${`Decrease ${toggle.title}`}
          aria-describedby=${controlDescription}
          disabled=${disabled}
          onClick=${decrease}
        >
          -
        </button>
        <input
          type="number"
          class="modal-field setting-number"
          min=${min}
          max=${max}
          step=${step}
          value=${String(safe)}
          aria-label=${toggle.title}
          aria-describedby=${controlDescription}
          disabled=${disabled}
          onChange=${(event) => commit(event.target.value)}
        />
        <button
          type="button"
          class="btn setting-stepper"
          aria-label=${`Increase ${toggle.title}`}
          aria-describedby=${controlDescription}
          disabled=${disabled}
          onClick=${increase}
        >
          +
        </button>
      </div>
      <input
        type="range"
        class="setting-range"
        min=${min}
        max=${max}
        step=${step}
        value=${rangeValue}
        aria-label=${`${toggle.title} slider`}
        aria-describedby=${controlDescription}
        disabled=${disabled}
        onChange=${(event) => commit(event.target.value)}
      />
      <div id=${metaId} class="setting-numeric-meta">
        <output class="setting-numeric-value">${numericLabel(toggle, value)}</output>
        <span class="setting-range-label">${strings.settings.allowedRange(min, max)}</span>
      </div>
      ${sentinelEntries.length > 0 &&
      html`<div class="setting-sentinels" role="group" aria-label=${`${toggle.title} presets`}>
        ${sentinelEntries.map(
          (entry) =>
            html`<button
              type="button"
              key=${entry.raw}
              class=${`btn setting-sentinel ${String(value) === entry.raw ? "is-selected" : ""}`}
              aria-pressed=${String(value) === entry.raw ? "true" : "false"}
              aria-describedby=${controlDescription}
              disabled=${disabled}
              onClick=${() => commit(entry.value)}
            >
              ${entry.label}
            </button>`,
        )}
      </div>`}
    </div>
  `;
}

function SettingButtonParam({ toggle, value, onChange, disabled, describedBy }) {
  const options = toggle.button_options || [];
  const selected = Number(value);

  return html`
    <div class="setting-segments" role="group" aria-label=${toggle.title} aria-describedby=${describedBy}>
      ${options.map(
        (option, index) =>
          html`<button
            type="button"
            key=${option}
            class=${`btn setting-segment ${index === selected ? "is-selected" : ""}`}
            aria-pressed=${index === selected ? "true" : "false"}
            disabled=${disabled}
            onClick=${() => onChange(index)}
          >
            ${option}
          </button>`,
      )}
    </div>
  `;
}

function SettingButtonToggle({ toggle, values, onWrite, disabled, describedBy }) {
  const labels = asArray(toggle.button_labels);
  const options = asArray(toggle.button_options);

  return html`
    <div class="setting-segments" role="group" aria-label=${toggle.title} aria-describedby=${describedBy}>
      ${labels.length === 0 && html`<span class="setting-unsupported">${unsupportedMessage(toggle)}</span>`}
      ${labels.map((label, index) => {
        const optionParam = options[index];
        const pressed = optionParam ? isParamTruthy(values, optionParam) : false;
        return html`<button
          type="button"
          key=${`${toggle.param}-${label}`}
          class=${`btn setting-segment ${pressed ? "is-selected" : ""}`}
          aria-pressed=${pressed ? "true" : "false"}
          disabled=${disabled || !optionParam}
          onClick=${() =>
            optionParam &&
            onWrite(
              { param: optionParam, title: label, toggle_type: "boolean", reboot_required: toggle.reboot_required },
              !pressed,
            )}
        >
          ${label}
        </button>`;
      })}
    </div>
  `;
}

function DisabledActionButtons({ toggle, reason, describedBy }) {
  const labels = asArray(toggle.button_labels);
  const renderedLabels = labels.length > 0 ? labels : [strings.settings.action];
  const reasonId = `setting-action-reason-${toggle.param}`;
  const controlDescription = joinIds(describedBy, reasonId);

  return html`
    <div class="setting-action-group">
      <div class="setting-action-buttons" role="group" aria-label=${toggle.title}>
        ${renderedLabels.map((label) => {
          const visibleLabel = actionButtonLabel(toggle, label);
          return html`<button
            type="button"
            key=${`${toggle.param}-${label}`}
            class="btn setting-action"
            aria-describedby=${controlDescription}
            disabled
          >
            ${visibleLabel}
          </button>`;
        })}
      </div>
      <span id=${reasonId} class="setting-disabled-reason">${reason}</span>
    </div>
  `;
}

function actionButtonLabel(toggle, label) {
  if (toggle.param === "UpdateTinygrad" && label.toUpperCase() === "UPDATE") {
    return strings.settings.updateModelManager;
  }
  if ((toggle.param === "DoToggleReset" || toggle.param === "DoToggleResetStock") && label.toUpperCase() === "RESET") {
    return strings.settings.resetToggles;
  }

  return label;
}

function SettingMultiButton({ toggle, value, describedBy }) {
  const currentValueId = value ? `${safeId(toggle.param)}-current-value` : null;

  return html`
    <div class="setting-compound">
      <${DisabledActionButtons}
        toggle=${toggle}
        reason=${actionOwnerReason(toggle)}
        describedBy=${joinIds(describedBy, currentValueId)}
      />
      ${value && html`<span id=${currentValueId} class="setting-current-value">${strings.settings.currentValue(value)}</span>`}
    </div>
  `;
}

function SettingUnsupported({ toggle }) {
  return html`<span class="setting-unsupported">${unsupportedMessage(toggle)}</span>`;
}

function controlFor(toggle, value, values, onWrite, disabled, describedBy) {
  const type = toggle.toggle_type;

  if (type === undefined || type === "boolean" || type === "manage") {
    return html`<${SettingSwitch}
      toggle=${toggle}
      value=${value}
      disabled=${disabled}
      describedBy=${describedBy}
      onChange=${(next) => onWrite(toggle, next)}
    />`;
  }
  if (type === "numeric") {
    return html`<${SettingNumeric}
      toggle=${toggle}
      value=${value}
      disabled=${disabled}
      describedBy=${describedBy}
      onChange=${(next) => onWrite(toggle, next)}
    />`;
  }
  if (type === "numeric_with_button") {
    return html`
      <div class="setting-compound">
        <${SettingNumeric}
          toggle=${toggle}
          value=${value}
          disabled=${disabled}
          describedBy=${describedBy}
          onChange=${(next) => onWrite(toggle, next)}
        />
        <${DisabledActionButtons} toggle=${toggle} reason=${strings.settings.onDeviceActionOwner} describedBy=${describedBy} />
      </div>
    `;
  }
  if (type === "button_param") {
    return html`<${SettingButtonParam}
      toggle=${toggle}
      value=${value}
      disabled=${disabled}
      describedBy=${describedBy}
      onChange=${(next) => onWrite(toggle, next)}
    />`;
  }
  if (type === "button_toggle") {
    return html`<${SettingButtonToggle}
      toggle=${toggle}
      values=${values}
      disabled=${disabled}
      describedBy=${describedBy}
      onWrite=${onWrite}
    />`;
  }
  if (type === "multi_button") {
    return html`<${SettingMultiButton} toggle=${toggle} value=${value} describedBy=${describedBy} />`;
  }
  if (type === "label") {
    return html`<span class="setting-readonly" aria-describedby=${describedBy}>${value ?? strings.settings.unset}</span>`;
  }
  if (type === "button") {
    return html`<${DisabledActionButtons} toggle=${toggle} reason=${actionOwnerReason(toggle)} describedBy=${describedBy} />`;
  }

  return html`<${SettingUnsupported} toggle=${toggle} />`;
}

function isReadOnly(toggle) {
  return toggle.toggle_type === "label" || toggle.toggle_type === "button";
}

function canReset(toggle, value, defaultValue) {
  return !isReadOnly(toggle) && defaultValue !== null && defaultValue !== undefined && value !== defaultValue;
}

export function SettingRow({ toggle, value, defaultValue, depth, values, status, onWrite }) {
  const disabled = status?.kind === "saving";
  const rowId = `setting-${safeId(toggle.param || toggle.title)}`;
  const descriptionId = toggle.description ? `${rowId}-description` : null;
  const rebootId = toggle.reboot_required ? `${rowId}-reboot` : null;
  const statusId = status ? `${rowId}-status` : null;
  const describedBy = joinIds(descriptionId, rebootId, statusId);

  return html`
    <div class=${`setting-row ${depth > 0 ? "is-nested" : ""}`} aria-busy=${disabled ? "true" : null}>
      <div class="setting-info">
        <span class="setting-title">${toggle.title}</span>
        ${toggle.description &&
        html`<span id=${descriptionId} class="setting-description">${plainText(toggle.description)}</span>`}
        ${toggle.reboot_required && html`<span id=${rebootId} class="setting-reboot">${strings.settings.rebootRequired}</span>`}
      </div>
      <div class="setting-control">
        ${controlFor(toggle, value, values, onWrite, disabled, describedBy)}
        ${canReset(toggle, value, defaultValue) &&
        html`<button
          type="button"
          class="btn btn-ghost setting-reset"
          aria-label=${`Reset ${toggle.title} to default`}
          aria-describedby=${describedBy}
          disabled=${disabled}
          onClick=${() => onWrite(toggle, defaultValue)}
        >
          ${strings.settings.reset}
        </button>`}
      </div>
      ${status &&
      html`<span id=${statusId} class=${settingStatusClass(status)} role=${status.kind === "failed" ? "alert" : "status"}>
        ${status.text}
      </span>`}
    </div>
  `;
}
