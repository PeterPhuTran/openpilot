import { http } from "./http.js";
import { routePath } from "./route_manifest.js";
import { strings } from "./strings.js";

// A flat, searchable index of in-app content beyond route labels: settings, theme/model names,
// troubleshoot issues, update branches, car makes, security-key names, and error-log names. Only cheap
// single-GET sources are indexed here. SSE streams and very large catalogs stay route-owned.

const INDEX_TIMEOUT_MS = 5000;

function sourceSignal(parentSignal) {
  const controller = new AbortController();
  let abortedByParent = false;
  const abortFromParent = () => {
    abortedByParent = true;
    controller.abort();
  };
  const timeout = setTimeout(() => controller.abort(), INDEX_TIMEOUT_MS);

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    abortedByParent: () => abortedByParent,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
    signal: controller.signal,
  };
}

function flattenSettings(schema) {
  const titles = [];
  if (schema?.tuning_level?.title) {
    titles.push(schema.tuning_level.title);
  }
  for (const category of schema?.categories ?? []) {
    for (const panel of category.sub_panels ?? []) {
      for (const toggle of panel.toggles ?? []) {
        if (toggle.title) {
          titles.push(toggle.title);
        }
      }
    }
  }
  return titles;
}

const SOURCES = [
  {
    type: strings.search.types.setting,
    route: routePath("settings"),
    deepLinkParam: "q",
    load: (signal) => http.get("/api/settings/schema", { signal }).then(flattenSettings),
  },
  {
    type: strings.search.types.theme,
    route: routePath("theme-maker"),
    load: (signal) => http.get("/api/themes/list", { signal }).then((data) => (data?.themes ?? []).map((theme) => theme.name)),
  },
  {
    type: strings.search.types.model,
    route: routePath("model-manager"),
    load: (signal) => http.get("/api/models/catalog", { signal }).then((models) => (models ?? []).map((model) => model.name)),
  },
  {
    type: strings.search.types.issue,
    route: routePath("troubleshoot"),
    load: (signal) => http.get("/api/troubleshoot", { signal }).then((data) => (data?.issues ?? []).map((issue) => issue.title)),
  },
  {
    type: strings.search.types.branch,
    route: routePath("update-manager"),
    load: (signal) => http.get("/api/update/branches", { signal }).then((data) => data?.branches ?? []),
  },
  {
    type: strings.search.types.carMake,
    route: routePath("vehicle-profile"),
    load: (signal) => http.get("/api/fingerprints/makes", { signal }),
  },
  {
    type: strings.search.types.securityKey,
    route: routePath("tsk"),
    load: (signal) => http.get("/api/tsk_keys", { signal }).then((keys) => (keys ?? []).map((key) => key.name)),
  },
  {
    type: strings.search.types.errorLog,
    route: routePath("error-logs"),
    load: (signal) => http.get("/api/error_logs", { signal }).then((logs) => (logs ?? []).map((log) => log.name)),
  },
];

async function loadSource(source, parentSignal) {
  const scopedSignal = sourceSignal(parentSignal);
  try {
    const labels = await source.load(scopedSignal.signal);
    return (labels ?? []).filter(Boolean).map((label) => ({
      label,
      type: source.type,
      href: source.deepLinkParam ? `${source.route}?${source.deepLinkParam}=${encodeURIComponent(label)}` : source.route,
    }));
  } catch (error) {
    if (scopedSignal.abortedByParent()) {
      throw error;
    }
    return [];
  } finally {
    scopedSignal.cleanup();
  }
}

export function buildSearchIndex({ signal } = {}) {
  return Promise.all(SOURCES.map((source) => loadSource(source, signal))).then((groups) => groups.flat());
}
