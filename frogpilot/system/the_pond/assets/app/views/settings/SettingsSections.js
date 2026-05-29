import { html } from "../../lib/html.js";
import { strings } from "../../lib/strings.js";
import { SettingRow } from "./SettingsControls.js";
import {
  DEVELOPER_LEVEL,
  asArray,
  isVisible,
  matchesQuery,
  safeId,
  settingStatusClass,
  statusForToggle,
} from "./SettingsUtils.js";

// Render a sub-panel's toggles as a flat, depth-aware list: a toggle whose parent_param is also in the
// panel is nested one level under it, mirroring the on-device sub-option indentation (B7 contract). Each
// toggle is still gated by tuning level + depends_on before it shows.
function visibleRows(toggles, level, values, query) {
  const params = new Set(toggles.map((toggle) => toggle.param));
  const optionParams = new Set(
    toggles.filter((toggle) => toggle.toggle_type === "button_toggle").flatMap((toggle) => asArray(toggle.button_options)),
  );

  return toggles
    .filter((toggle) => !optionParams.has(toggle.param) && isVisible(toggle, level, values) && matchesQuery(toggle, query))
    .map((toggle) => ({
      toggle,
      depth: toggle.parent_param && params.has(toggle.parent_param) ? 1 : 0,
    }));
}

export function visibleRowCountForCategory(category, level, values, query) {
  return category.sub_panels.reduce((count, panel) => count + visibleRows(panel.toggles, level, values, query).length, 0);
}

function SubPanel({ panel, level, values, defaults, query, statuses, onWrite }) {
  const rows = visibleRows(panel.toggles, level, values, query);
  if (rows.length === 0) {
    return null;
  }

  return html`
    <div class="settings-subpanel">
      <h3 class="settings-subpanel-title">${panel.name}</h3>
      ${rows.map(
        ({ toggle, depth }) =>
          html`<${SettingRow}
            key=${toggle.param}
            toggle=${toggle}
            value=${values[toggle.param] ?? null}
            defaultValue=${defaults[toggle.param] ?? null}
            depth=${depth}
            values=${values}
            status=${statusForToggle(toggle, statuses)}
            onWrite=${onWrite}
          />`,
      )}
    </div>
  `;
}

export function Category({ category, expanded, forceExpanded, level, values, defaults, query, statuses, onToggle, onWrite }) {
  const isExpanded = forceExpanded || expanded;
  const categoryTitleId = `settings-category-${safeId(category.name)}-title`;
  const panels = category.sub_panels
    .map((panel) => ({ panel, rows: visibleRows(panel.toggles, level, values, query) }))
    .filter((entry) => entry.rows.length > 0);

  // A category with nothing to show at this tuning level (or filtered out by the search) is hidden
  // entirely rather than rendering an empty accordion.
  if (panels.length === 0) {
    return null;
  }

  return html`
    <section class=${`settings-category ${forceExpanded ? "is-force-expanded" : ""}`} aria-labelledby=${categoryTitleId}>
      <h2 class="settings-category-title">
        ${forceExpanded
          ? html`<span class="settings-category-head settings-category-static">
              <span id=${categoryTitleId} class="settings-category-name">${category.name}</span>
              <span class="settings-filtered-note">${strings.settings.filteredCategory}</span>
            </span>`
          : html`<button
              type="button"
              class="settings-category-head"
              aria-expanded=${isExpanded ? "true" : "false"}
              onClick=${onToggle}
            >
              <span id=${categoryTitleId} class="settings-category-name">${category.name}</span>
              <span class="settings-category-chevron">${isExpanded ? "-" : "+"}</span>
            </button>`}
      </h2>
      ${isExpanded &&
      html`<div class="settings-category-body">
        ${panels.map(
          ({ panel }) =>
            html`<${SubPanel}
              key=${panel.name}
              panel=${panel}
              level=${level}
              values=${values}
              defaults=${defaults}
              query=${query}
              statuses=${statuses}
              onWrite=${onWrite}
            />`,
        )}
      </div>`}
    </section>
  `;
}

export function TuningLevelSelector({ toggle, level, status, onSelect }) {
  const max = Number.isFinite(toggle.max_value) ? toggle.max_value : DEVELOPER_LEVEL;
  const levels = [];
  for (let value = 0; value <= max; value += 1) {
    levels.push(value);
  }
  const disabled = status?.kind === "saving";
  const labelId = "settings-tuning-label";
  const statusId = status ? "settings-tuning-status" : null;

  return html`
    <div class="settings-tuning" aria-busy=${disabled ? "true" : null}>
      <span id=${labelId} class="settings-tuning-label">${strings.settings.tuningLevel}</span>
      <div class="setting-segments" role="group" aria-labelledby=${labelId} aria-describedby=${statusId}>
        ${levels.map(
          (value) =>
            html`<button
              type="button"
              key=${value}
              class=${`btn setting-segment ${value === level ? "is-selected" : ""}`}
              aria-pressed=${value === level ? "true" : "false"}
              disabled=${disabled}
              onClick=${() => onSelect(value)}
            >
              ${toggle.value_map?.[String(value)] ?? value}
            </button>`,
        )}
      </div>
      ${status &&
      html`<span id=${statusId} class=${settingStatusClass(status)} role=${status.kind === "failed" ? "alert" : "status"}>
        ${status.text}
      </span>`}
    </div>
  `;
}
