import { useMemo, useRef, useState } from "preact/hooks";
import { useLocation } from "preact-iso";

import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { strings } from "../../lib/strings.js";
import { Category, TuningLevelSelector, visibleRowCountForCategory } from "./SettingsSections.js";
import { useRouteSearch, useSettingsData, useSettingsWriter } from "./SettingsState.js";
import { DEVELOPER_LEVEL } from "./SettingsUtils.js";

function LoadingState() {
  return html`<section class="settings"><p class="settings-message" role="status">${strings.settings.loading}</p></section>`;
}

function ErrorState({ retryRef, reload }) {
  return html`
    <section class="settings">
      <p class="settings-message" role="alert">${strings.settings.error}</p>
      <button ref=${retryRef} class="btn btn-primary settings-retry" onClick=${() => reload({ focusHeading: true })}>
        ${strings.settings.retry}
      </button>
    </section>
  `;
}

function SettingsHeader({ headingRef, query, setQuery, visibleRowCount }) {
  return html`
    <header class="settings-header">
      <h1 ref=${headingRef} class="settings-title" tabindex="-1">${strings.settings.title}</h1>
      <div class="settings-search-wrap">
        <input
          class="modal-field settings-search"
          type="search"
          value=${query}
          placeholder=${strings.settings.searchPlaceholder}
          aria-label=${strings.settings.searchPlaceholder}
          onInput=${(event) => setQuery(event.target.value)}
        />
        <span class="sr-only" role="status" aria-live="polite" aria-label=${strings.settings.searchResults}>
          ${strings.settings.searchResultCount(visibleRowCount)}
        </span>
      </div>
    </header>
  `;
}

function visibleCategories(schema, level, values, normalizedQuery) {
  return schema.categories
    .map((category) => ({
      category,
      visibleCount: visibleRowCountForCategory(category, level, values, normalizedQuery),
    }))
    .filter((entry) => entry.visibleCount > 0);
}

function SettingsCategories({
  categories,
  searching,
  expanded,
  level,
  values,
  defaults,
  normalizedQuery,
  statuses,
  onToggle,
  onWrite,
}) {
  if (categories.length === 0) {
    return html`<p class="settings-message">${searching ? strings.settings.searchEmpty : strings.settings.empty}</p>`;
  }

  return categories.map(
    ({ category }) =>
      html`<${Category}
        key=${category.name}
        category=${category}
        expanded=${Boolean(expanded[category.name])}
        forceExpanded=${searching}
        level=${level}
        values=${values}
        defaults=${defaults}
        query=${normalizedQuery}
        statuses=${statuses}
        onToggle=${() => onToggle(category.name)}
        onWrite=${onWrite}
      />`,
  );
}

function DeveloperModal({ onConfirm, onCancel }) {
  return html`<${Modal}
    title=${strings.settings.developerTitle}
    message=${strings.settings.developerWarning}
    confirmLabel=${strings.settings.developerConfirm}
    danger
    onConfirm=${onConfirm}
    onCancel=${onCancel}
  />`;
}

export function Settings() {
  const headingRef = useRef(null);
  const retryRef = useRef(null);
  const { query: routeQuery } = useLocation();
  const [query, setQuery] = useRouteSearch(routeQuery);
  const [expanded, setExpanded] = useState({});
  const [pendingDeveloper, setPendingDeveloper] = useState(false);

  const settings = useSettingsData({ headingRef, retryRef });
  const { schema, values, setValues, defaults, loading, failed, reload, statuses, setStatuses } = settings;
  const writeParam = useSettingsWriter({ values, setValues, setStatuses });
  const tuningToggle = schema?.tuning_level;
  const level = useMemo(() => {
    const raw = Number(values[tuningToggle?.param]);
    return Number.isFinite(raw) ? raw : 0;
  }, [values, tuningToggle]);

  const selectLevel = (value) => {
    if (value === DEVELOPER_LEVEL && level < DEVELOPER_LEVEL) {
      setPendingDeveloper(true);
      return;
    }
    writeParam(tuningToggle, value);
  };
  const confirmDeveloper = () => {
    setPendingDeveloper(false);
    writeParam(tuningToggle, DEVELOPER_LEVEL);
  };
  const toggleCategory = (name) => setExpanded((current) => ({ ...current, [name]: !current[name] }));

  if (loading) return html`<${LoadingState} />`;
  if (failed || !schema) return html`<${ErrorState} retryRef=${retryRef} reload=${reload} />`;

  const normalizedQuery = query.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  const categories = visibleCategories(schema, level, values, normalizedQuery);
  const visibleRowCount = categories.reduce((count, entry) => count + entry.visibleCount, 0);

  return html`
    <section class="settings">
      <${SettingsHeader} headingRef=${headingRef} query=${query} setQuery=${setQuery} visibleRowCount=${visibleRowCount} />
      ${tuningToggle &&
      html`<${TuningLevelSelector}
        toggle=${tuningToggle}
        level=${level}
        status=${statuses[tuningToggle.param]}
        onSelect=${selectLevel}
      />`}
      <${SettingsCategories}
        categories=${categories}
        searching=${searching}
        expanded=${expanded}
        level=${level}
        values=${values}
        defaults=${defaults}
        normalizedQuery=${normalizedQuery}
        statuses=${statuses}
        onToggle=${toggleCategory}
        onWrite=${writeParam}
      />
      ${pendingDeveloper &&
      html`<${DeveloperModal} onConfirm=${confirmDeveloper} onCancel=${() => setPendingDeveloper(false)} />`}
    </section>
  `;
}
