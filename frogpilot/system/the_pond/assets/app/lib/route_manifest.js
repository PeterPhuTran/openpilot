export const NAV_SECTION_KEYS = Object.freeze([
  "home",
  "navigation",
  "recordings",
  "settings",
  "personalization",
  "vehicle",
  "system",
]);

const COVERAGE_OFF = Object.freeze({
  a11y: false,
  deviceSmoke: false,
  functional: false,
  layout: false,
  lighthouse: false,
  perf: false,
  visual: false,
});

const coverage = (flags) => Object.freeze({ ...COVERAGE_OFF, ...flags });

const lighthouseThresholds = (performance) =>
  Object.freeze({
    accessibility: 0.95,
    bestPractices: 0.85,
    performance,
  });

const resourceBudgetDecision = (reason, revisit) =>
  Object.freeze({
    owner: "route-packet",
    reason,
    revisit,
    status: "deferred",
  });

const visualBaselineDecision = (reason, revisit) =>
  Object.freeze({
    owner: "route-packet",
    reason,
    revisit,
    status: "deferred",
  });

const freezeRoute = (route) =>
  Object.freeze({
    ...route,
    coverage: Object.freeze(route.coverage),
    lighthouseThresholds: route.lighthouseThresholds ? Object.freeze(route.lighthouseThresholds) : undefined,
    performanceBudget: route.performanceBudget ? Object.freeze(route.performanceBudget) : undefined,
    resourceBudgetDecision: route.resourceBudgetDecision ? Object.freeze(route.resourceBudgetDecision) : undefined,
    searchTags: route.searchTags ? Object.freeze(route.searchTags) : undefined,
    visualBaselineDecision: route.visualBaselineDecision ? Object.freeze(route.visualBaselineDecision) : undefined,
  });

export const ROUTES = Object.freeze(
  [
    {
      componentKey: "home",
      coverage: coverage({
        a11y: true,
        deviceSmoke: true,
        functional: true,
        lighthouse: true,
        perf: true,
        visual: true,
      }),
      icon: "home",
      id: "home",
      labelKey: "home",
      lighthouseThresholds: lighthouseThresholds(0.75),
      pageTitleKey: "home.title",
      path: "/",
      performanceBudget: { domNodes: 1500, encodedKb: 900, requests: 85 },
      qualityTier: "core",
      readySelector: ".home-title",
      searchTags: ["dashboard", "device", "drives", "recent drives", "software", "status", "storage", "update", "vitals"],
      sectionKey: "home",
    },
    {
      componentKey: "speedLimits",
      coverage: coverage({ a11y: true, functional: true }),
      icon: "download",
      id: "speed-limits",
      labelKey: "speedLimits",
      pageTitleKey: "speedLimits.title",
      path: "/download_speed_limits",
      qualityTier: "standard",
      readySelector: ".speed-limits-title",
      searchTags: ["data", "speed", "speed limits"],
      sectionKey: "navigation",
    },
    {
      componentKey: "navKeys",
      coverage: coverage({ a11y: true, functional: true }),
      icon: "key",
      id: "navigation-keys",
      labelKey: "navigationKeys",
      pageTitleKey: "navigation.keysTitle",
      path: "/manage_navigation_keys",
      qualityTier: "high-risk",
      readySelector: ".navkeys-title",
      searchTags: ["amap", "map keys", "mapbox", "navigation"],
      resourceBudgetDecision: resourceBudgetDecision(
        "Navigation keys is a secret-management form with no long-lived route resources; packet approval will add resource budgets if provider-key validation or real-provider probes add background work.",
        "Navigation Keys page packet",
      ),
      sectionKey: "navigation",
      visualBaselineDecision: visualBaselineDecision(
        "Navigation keys is high-risk because it manages provider credentials; its page packet must add masked-value, validation, saved, deleted, and error-state screenshots without leaking secrets.",
        "Navigation Keys page packet",
      ),
    },
    {
      componentKey: "maps",
      coverage: coverage({ a11y: true, functional: true, visual: true }),
      icon: "map",
      id: "offline-maps",
      labelKey: "maps",
      pageTitleKey: "maps.title",
      path: "/manage_maps",
      qualityTier: "high-risk",
      readySelector: ".maps-title",
      searchTags: ["download", "maps", "offline"],
      resourceBudgetDecision: resourceBudgetDecision(
        "Offline maps depends on real catalog, download, cancel, remove, storage, and cache behavior; hard budgets require the Offline Maps device packet.",
        "Offline Maps page packet",
      ),
      sectionKey: "navigation",
    },
    {
      componentKey: "navigationDestination",
      coverage: coverage({ a11y: true, functional: true }),
      icon: "map-pin",
      id: "navigation-destination",
      labelKey: "navigationDestination",
      pageTitleKey: "nav.navigationDestination",
      path: "/set_navigation_destination",
      qualityTier: "high-risk",
      readySelector: ".navigation",
      searchTags: ["destination", "map", "navigation", "route"],
      resourceBudgetDecision: resourceBudgetDecision(
        "Set Destination owns map/provider resources and real Mapbox behavior; hard budgets require provider-key and map lifecycle proof in its page packet.",
        "Set Destination page packet",
      ),
      sectionKey: "navigation",
      visualBaselineDecision: visualBaselineDecision(
        "Set Destination is high-risk because map/provider keys, route geometry, provider failures, and start/cancel states need route-specific fixtures and reviewed map screenshots before baseline approval.",
        "Set Destination page packet",
      ),
    },
    {
      componentKey: "dashcamRoutes",
      coverage: coverage({ a11y: true, functional: true, perf: true, visual: true }),
      icon: "camera",
      id: "dashcam-routes",
      labelKey: "dashcamRoutes",
      pageTitleKey: "dashcamRoutes.title",
      path: "/dashcam_routes",
      performanceBudget: { domNodes: 1600, encodedKb: 1000, requests: 90 },
      qualityTier: "standard",
      readySelector: ".routes-title",
      searchTags: ["dashcam", "footage", "route", "video"],
      sectionKey: "recordings",
    },
    {
      componentKey: "screenRecordings",
      coverage: coverage({
        a11y: true,
        deviceSmoke: true,
        functional: true,
        layout: true,
        lighthouse: true,
        perf: true,
        visual: true,
      }),
      icon: "video",
      id: "screen-recordings",
      labelKey: "recordings",
      lighthouseThresholds: lighthouseThresholds(0.75),
      pageTitleKey: "recordings.title",
      path: "/screen_recordings",
      performanceBudget: { domNodes: 1200, encodedKb: 900, requests: 80 },
      qualityTier: "core",
      readySelector: ".recordings-title",
      searchTags: ["recording", "screen", "video"],
      sectionKey: "recordings",
    },
    {
      componentKey: "modelManager",
      coverage: coverage({ a11y: true, functional: true, visual: true }),
      icon: "bot",
      id: "model-manager",
      labelKey: "modelManager",
      pageTitleKey: "modelManager.title",
      path: "/model_manager",
      qualityTier: "standard",
      readySelector: ".model-manager-title",
      searchTags: ["download", "model"],
      sectionKey: "settings",
    },
    {
      componentKey: "settings",
      coverage: coverage({ a11y: true, deviceSmoke: true, functional: true, lighthouse: true, perf: true, visual: true }),
      icon: "toggle",
      id: "settings",
      labelKey: "settings",
      lighthouseThresholds: lighthouseThresholds(0.75),
      pageTitleKey: "settings.title",
      path: "/settings",
      performanceBudget: { domNodes: 1800, encodedKb: 1100, requests: 80 },
      qualityTier: "high-risk",
      readySelector: ".settings-title",
      searchTags: ["numeric controls", "settings", "toggles", "tuning"],
      sectionKey: "settings",
    },
    {
      componentKey: "themeMaker",
      coverage: coverage({ a11y: true, functional: true, lighthouse: true, perf: true, visual: true }),
      icon: "palette",
      id: "theme-maker",
      labelKey: "themeMaker",
      lighthouseThresholds: lighthouseThresholds(0.65),
      pageTitleKey: "themeMaker.title",
      path: "/theme_maker",
      performanceBudget: { domNodes: 2200, encodedKb: 1300, requests: 90 },
      qualityTier: "high-risk",
      readySelector: ".theme-maker-title",
      searchTags: ["colors", "icons", "sounds", "theme"],
      sectionKey: "personalization",
    },
    {
      availabilityFlag: "doorsAvailable",
      componentKey: "doors",
      coverage: coverage({ a11y: true, functional: true }),
      icon: "door",
      id: "doors",
      labelKey: "doors",
      pageTitleKey: "doors.title",
      path: "/lock_or_unlock_doors",
      qualityTier: "standard",
      readySelector: ".doors-title",
      searchTags: ["doors", "lock", "unlock"],
      sectionKey: "vehicle",
    },
    {
      availabilityFlag: "tskAvailable",
      componentKey: "tsk",
      coverage: coverage({ a11y: true, functional: true, layout: true }),
      icon: "key",
      id: "tsk",
      labelKey: "tsk",
      pageTitleKey: "tsk.title",
      path: "/tsk_manager",
      qualityTier: "high-risk",
      readySelector: ".tsk-title",
      searchTags: ["secoc", "security keys", "toyota"],
      resourceBudgetDecision: resourceBudgetDecision(
        "Toyota Security Keys is a write-only secret form with no idle long-lived resources; packet approval will add budgets if apply/delete device probes add background work.",
        "Toyota Security Keys page packet",
      ),
      sectionKey: "vehicle",
      visualBaselineDecision: visualBaselineDecision(
        "Toyota Security Keys is high-risk because raw SecOC material must never appear in screenshots; its page packet must prove masked, invalid, apply, delete, and corrupt-param visual states.",
        "Toyota Security Keys page packet",
      ),
    },
    {
      componentKey: "vehicleFeatures",
      coverage: coverage({ a11y: true, functional: true }),
      icon: "car",
      id: "vehicle-profile",
      labelKey: "vehicleFeatures",
      pageTitleKey: "vehicle.title",
      path: "/vehicle_features",
      qualityTier: "standard",
      readySelector: ".vehicle-title",
      searchTags: ["car", "fingerprint", "vehicle"],
      sectionKey: "vehicle",
    },
    {
      componentKey: "toggles",
      coverage: coverage({ a11y: true, functional: true }),
      icon: "save",
      id: "toggles",
      labelKey: "toggles",
      pageTitleKey: "toggles.title",
      path: "/manage_toggles",
      qualityTier: "high-risk",
      readySelector: ".toggles-title",
      searchTags: ["backup", "reset", "restore", "toggles"],
      resourceBudgetDecision: resourceBudgetDecision(
        "Backup and reset uses file download/upload and destructive reset paths; hard resource budgets belong with the backup/reset page packet and restore-file matrix.",
        "Backup and reset page packet",
      ),
      sectionKey: "system",
      visualBaselineDecision: visualBaselineDecision(
        "Backup and reset is high-risk because restore uploads and reset actions need destructive confirmation, malformed-file, success, failure, and recovery screenshots owned by its page packet.",
        "Backup and reset page packet",
      ),
    },
    {
      componentKey: "errorLogs",
      coverage: coverage({ a11y: true, functional: true }),
      icon: "alert",
      id: "error-logs",
      labelKey: "errorLogs",
      pageTitleKey: "errorLogs.title",
      path: "/manage_error_logs",
      qualityTier: "standard",
      readySelector: ".error-logs-title",
      searchTags: ["errors", "issues", "logs"],
      sectionKey: "system",
    },
    {
      componentKey: "tailscale",
      coverage: coverage({ a11y: true, functional: true }),
      icon: "wifi",
      id: "tailscale",
      labelKey: "tailscale",
      pageTitleKey: "tailscale.title",
      path: "/manage_tailscale",
      qualityTier: "high-risk",
      readySelector: ".tailscale-title",
      searchTags: ["remote access", "tailscale"],
      resourceBudgetDecision: resourceBudgetDecision(
        "Tailscale setup/uninstall can affect network access and install state; hard resource budgets require the explicitly approved Tailscale packet without running install flows by default.",
        "Tailscale page packet",
      ),
      sectionKey: "system",
      visualBaselineDecision: visualBaselineDecision(
        "Tailscale is high-risk because setup, auth URL, installed, failed, and uninstall states can affect remote access; its page packet must own screenshots without running install by default.",
        "Tailscale page packet",
      ),
    },
    {
      componentKey: "tmux",
      coverage: coverage({ a11y: true, functional: true }),
      icon: "terminal",
      id: "tmux",
      labelKey: "tmux",
      pageTitleKey: "tmux.title",
      path: "/manage_tmux",
      qualityTier: "standard",
      readySelector: ".tmux-title",
      searchTags: ["console", "logs", "tmux"],
      sectionKey: "system",
    },
    {
      componentKey: "troubleshoot",
      coverage: coverage({ a11y: true, functional: true }),
      icon: "wrench",
      id: "troubleshoot",
      labelKey: "troubleshoot",
      pageTitleKey: "troubleshoot.title",
      path: "/troubleshoot",
      qualityTier: "standard",
      readySelector: ".troubleshoot-title",
      searchTags: ["issue records", "troubleshoot"],
      sectionKey: "system",
    },
    {
      componentKey: "updateManager",
      coverage: coverage({ a11y: true, functional: true, visual: true }),
      icon: "refresh",
      id: "update-manager",
      labelKey: "updateManager",
      pageTitleKey: "update.title",
      path: "/update_manager",
      qualityTier: "standard",
      readySelector: ".update-title",
      searchTags: ["branch", "update"],
      sectionKey: "system",
    },
  ].map(freezeRoute),
);

const testRoute = (route) =>
  Object.freeze({
    ...route,
    name: route.id,
    ready: route.readySelector,
  });

export const SHELL_TARGETS = Object.freeze([
  Object.freeze({
    coverage: coverage({ a11y: true, layout: true, visual: true }),
    id: "lockout",
    kind: "shell",
    mock: Object.freeze({ onroad: true }),
    name: "lockout",
    path: "/",
    ready: ".lockout",
    readySelector: ".lockout",
  }),
]);

export const ROUTE_PATHS = Object.freeze(Object.fromEntries(ROUTES.map((route) => [route.id, route.path])));

export function routePath(id) {
  if (!Object.prototype.hasOwnProperty.call(ROUTE_PATHS, id)) {
    throw new Error(`Unknown route id: ${id}`);
  }
  return ROUTE_PATHS[id];
}

export const APP_ROUTES = Object.freeze(ROUTES.filter((route) => route.componentKey));
export const NAV_ROUTES = Object.freeze(ROUTES.filter((route) => route.labelKey && route.sectionKey && route.icon));
export const QUALITY_ROUTES = Object.freeze(ROUTES.filter((route) => route.coverage.a11y).map(testRoute));
export const VISUAL_PAGE_ROUTES = Object.freeze(ROUTES.filter((route) => route.coverage.visual).map(testRoute));
export const VISUAL_ROUTES = Object.freeze([...VISUAL_PAGE_ROUTES, ...SHELL_TARGETS]);
export const VISUAL_BASELINE_SCENARIOS = Object.freeze(
  VISUAL_ROUTES.map((route) =>
    Object.freeze({
      artifactKind: "primary route screenshot",
      id: `${route.id}:primary`,
      mock: route.mock,
      name: route.name,
      path: route.path,
      ready: route.ready,
      routeId: route.id,
      snapshotName: `${route.name}.png`,
      state: "primary",
      viewportProfile: "project-default",
    }),
  ),
);
export const PERFORMANCE_ROUTES = Object.freeze(
  ROUTES.filter((route) => route.coverage.perf).map((route) =>
    Object.freeze({
      ...testRoute(route),
      ...route.performanceBudget,
    }),
  ),
);
export const LIGHTHOUSE_ROUTES = Object.freeze(
  ROUTES.filter((route) => route.coverage.lighthouse).map((route) =>
    Object.freeze({
      coverage: route.coverage,
      id: route.id,
      name: route.id,
      path: route.path,
      thresholds: route.lighthouseThresholds,
    }),
  ),
);
export const DEVICE_SMOKE_ROUTES = Object.freeze(ROUTES.filter((route) => route.coverage.deviceSmoke).map(testRoute));
