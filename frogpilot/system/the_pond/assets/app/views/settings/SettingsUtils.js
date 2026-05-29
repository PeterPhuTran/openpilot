import { strings } from "../../lib/strings.js";

export const DEVELOPER_LEVEL = 3;

// Device toggle copy is authored as HTML fragments (e.g. "<b>…</b><br>…"). The renderer treats it as
// plain text — strip the markup and collapse whitespace so it shows the same words without injecting
// markup (REWRITE_PLAN §6: textContent only). The schema is device-authored copy served verbatim.
export function plainText(value) {
  if (!value) {
    return "";
  }

  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function paramLevel(toggle) {
  return Number.isFinite(toggle.tuning_level) ? toggle.tuning_level : 0;
}

// A param string is "true" when it is the persisted "1"; anything else (incl. null / "0") is false. The
// view never invents a default for an unwritten key — depends_on then reads it as false (REWRITE_PLAN §13).
export function isParamTruthy(values, param) {
  return values[param] === "1";
}

// depends_on entries gate visibility against the live param values. Each entry is a plain param ("X",
// needs X truthy), a negated param ("!X", needs X falsy), or a "!visible:Y" form (the C++ uses it to
// hide a row while another control is showing). "!visible:Y" can only be evaluated against the same
// truthiness signal here, so it is treated as "!Y" — the conservative reading that keeps a real setting
// reachable rather than hiding it on data B7 does not have (REWRITE_PLAN §13, B7 contract).
function dependencyMet(values, expression) {
  let param = expression;
  let negated = false;

  if (param.startsWith("!")) {
    negated = true;
    param = param.slice(1);
  }
  if (param.startsWith("visible:")) {
    param = param.slice("visible:".length);
  }

  const truthy = isParamTruthy(values, param);
  return negated ? !truthy : truthy;
}

function dependenciesMet(toggle, values) {
  if (!toggle.depends_on) {
    return true;
  }

  return toggle.depends_on.every((expression) => dependencyMet(values, expression));
}

// A toggle is visible when the active tuning level reaches it AND every depends_on expression is met.
// car_params is intentionally NOT gated here: the per-car capability flags are not one of B7's
// endpoints, so hiding a real setting on missing capability data would lose it — default show
// (REWRITE_PLAN §13, B7 contract "Fidelity risks").
export function isVisible(toggle, level, values) {
  return level >= paramLevel(toggle) && dependenciesMet(toggle, values);
}

export function matchesQuery(toggle, query) {
  if (!query) {
    return true;
  }

  const haystack = `${toggle.title || ""} ${plainText(toggle.description)}`.toLowerCase();
  return haystack.includes(query);
}

export function numericLabel(toggle, raw) {
  if (raw === null || raw === "") {
    return strings.settings.unset;
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return raw;
  }

  const mapped = toggle.value_map?.[String(numeric)];
  if (mapped) {
    return mapped;
  }

  return toggle.unit ? `${numeric} ${toggle.unit}` : `${numeric}`;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function numericFromValue(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function decimalPlaces(value) {
  const text = String(value);
  const decimal = text.split(".")[1];
  return decimal ? decimal.length : 0;
}

export function normalizeStep(value, step) {
  const places = decimalPlaces(step);
  return Number(value.toFixed(Math.min(places, 6)));
}

export function valueMapEntries(toggle) {
  return Object.entries(toggle.value_map ?? {})
    .map(([raw, label]) => ({ label, raw, value: Number(raw) }))
    .filter((entry) => Number.isFinite(entry.value));
}

export function settingStatusClass(status) {
  return status ? `setting-row-status is-${status.kind}` : "setting-row-status";
}

export function safeId(value) {
  return String(value || "setting")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function joinIds(...ids) {
  const joined = ids.filter(Boolean).join(" ");
  return joined || null;
}

export function statusForToggle(toggle, statuses) {
  if (statuses[toggle.param]) {
    return statuses[toggle.param];
  }

  if (toggle.toggle_type !== "button_toggle") {
    return null;
  }

  return asArray(toggle.button_options)
    .map((param) => statuses[param])
    .find(Boolean);
}

export function actionOwnerReason(toggle) {
  if (toggle.param === "DoToggleReset" || toggle.param === "DoToggleResetStock") {
    return strings.settings.backupResetOwner;
  }

  return strings.settings.dedicatedActionOwner;
}

export function unsupportedMessage(toggle) {
  return strings.settings.unsupportedControl(toggle.toggle_type ?? "unknown");
}
