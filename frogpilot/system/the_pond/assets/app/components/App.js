import { useEffect, useRef, useState } from "preact/hooks";
import { LocationProvider, Route, Router, useLocation } from "preact-iso";

import { Lockout } from "./Lockout.js";
import { NotFound } from "./NotFound.js";
import { Sidebar } from "./Sidebar.js";
import { html } from "../lib/html.js";
import { http } from "../lib/http.js";
import { APP_ROUTES } from "../lib/route_manifest.js";
import { strings } from "../lib/strings.js";

const HEALTH_POLL_MS = 4000;
const ROUTE_COMPONENTS = Object.freeze({
  dashcamRoutes: lazyRoute("../views/dashcam_routes/DashcamRoutes.js", "DashcamRoutes"),
  doors: lazyRoute("../views/doors/Doors.js", "Doors"),
  errorLogs: lazyRoute("../views/error_logs/ErrorLogs.js", "ErrorLogs"),
  home: lazyRoute("../views/home/Home.js", "Home"),
  maps: lazyRoute("../views/maps/Maps.js", "Maps"),
  modelManager: lazyRoute("../views/model_manager/ModelManagerView.js", "ModelManagerView"),
  navigationDestination: lazyRoute("../views/navigation_destination/NavigationDestination.js", "NavigationDestination"),
  navKeys: lazyRoute("../views/navigation_keys/NavKeys.js", "NavKeys"),
  screenRecordings: lazyRoute("../views/screen_recordings/ScreenRecordings.js", "ScreenRecordings"),
  settings: lazyRoute("../views/settings/Settings.js", "Settings"),
  speedLimits: lazyRoute("../views/speed_limits/SpeedLimits.js", "SpeedLimits"),
  tailscale: lazyRoute("../views/tailscale/Tailscale.js", "Tailscale"),
  themeMaker: lazyRoute("../views/theme_maker/ThemeMaker.js", "ThemeMaker"),
  tmux: lazyRoute("../views/tmux/Tmux.js", "Tmux"),
  toggles: lazyRoute("../views/toggles/Toggles.js", "Toggles"),
  troubleshoot: lazyRoute("../views/troubleshoot/Troubleshoot.js", "Troubleshoot"),
  tsk: lazyRoute("../views/tsk/TskKeys.js", "TskKeys"),
  updateManager: lazyRoute("../views/update_manager/UpdateManager.js", "UpdateManager"),
  vehicleFeatures: lazyRoute("../views/vehicle_features/VehicleFeatures.js", "VehicleFeatures"),
});

function lazyRoute(modulePath, exportName) {
  let Component = null;
  let loadPromise = null;
  let attempt = 0;

  const load = () => {
    const specifier = attempt === 0 ? modulePath : `${modulePath}?route-retry=${attempt}`;
    loadPromise = import(specifier)
      .then((module) => {
        Component = module[exportName];
        if (!Component) {
          throw new Error(`Route module is missing export ${exportName}`);
        }
        return Component;
      })
      .catch((error) => {
        loadPromise = null;
        throw error;
      });
    return loadPromise;
  };

  return function LazyRoute() {
    const [LoadedComponent, setLoadedComponent] = useState(() => Component);
    const [loadError, setLoadError] = useState(null);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
      if (LoadedComponent) {
        return undefined;
      }

      let active = true;
      const promise = loadPromise ?? load();

      promise
        .then((resolved) => {
          if (active) {
            setLoadError(null);
            setLoadedComponent(() => resolved);
          }
        })
        .catch((error) => {
          console.warn(error);
          if (active) {
            setLoadError(error);
          }
        });

      return () => {
        active = false;
      };
    }, [LoadedComponent, reloadKey]);

    const retry = () => {
      loadPromise = null;
      attempt += 1;
      setLoadError(null);
      setLoadedComponent(() => Component);
      setReloadKey((key) => key + 1);
    };

    if (!LoadedComponent) {
      if (loadError) {
        return html`<${RouteLoadError} onRetry=${retry} />`;
      }
      return html`<p class="app-loading" role="status">${strings.app.loadingRoute}</p>`;
    }

    return html`<${LoadedComponent} />`;
  };
}

function RouteLoadError({ onRetry }) {
  return html`
    <div class="app-loading" role="alert">
      <p>${strings.app.routeLoadError}</p>
      <button class="btn btn-primary" type="button" onClick=${onRetry}>${strings.app.routeLoadRetry}</button>
    </div>
  `;
}

function valueForKey(key) {
  return key.split(".").reduce((current, part) => current?.[part], strings);
}

function componentFor(route) {
  const component = ROUTE_COMPONENTS[route.componentKey];
  if (!component) {
    throw new Error(`Unknown route component: ${route.componentKey}`);
  }
  return component;
}

// The shell owns the only background work allowed while onroad: polling health to learn the driving
// state. When onroad it renders just the Lockout, so every routed view unmounts and its own
// background work stops — the gate is enforced by structure, not by trusting each view (§6).
export function App() {
  const [onroad, setOnroad] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    let active = true;
    let timer;

    const poll = async () => {
      try {
        const status = await http.get("/api/health", { signal: AbortSignal.timeout(HEALTH_POLL_MS) });
        if (active) {
          setOnroad(Boolean(status.onroad));
        }
      } catch {
        // Health unreadable: fail closed and lock, matching the backend gate (§6).
        if (active) {
          setOnroad(true);
        }
      } finally {
        if (active) {
          timer = setTimeout(poll, HEALTH_POLL_MS);
        }
      }
    };

    poll();

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (onroad) {
      setSidebarOpen(false);
    }
  }, [onroad]);

  if (onroad === null) {
    return html`<div class="app-loading">${strings.app.connecting}</div>`;
  }

  if (onroad) {
    return html`<${Lockout} />`;
  }

  return html`
    <${LocationProvider}>
      <${AppShell} sidebarOpen=${sidebarOpen} setSidebarOpen=${setSidebarOpen} />
    <//>
  `;
}

function AppShell({ sidebarOpen, setSidebarOpen }) {
  const { path } = useLocation();
  const mainRef = useRef(null);
  const activeRoute = APP_ROUTES.find((route) => route.path === path);
  const activeRouteTitle = valueForKey(activeRoute?.pageTitleKey || "notFound.title") || strings.notFound.title;

  useEffect(() => {
    document.title = `${activeRouteTitle} | ${strings.app.name}`;

    const frame = requestAnimationFrame(() => {
      if (!mainRef.current || mainRef.current.hasAttribute("inert")) {
        return;
      }
      mainRef.current.focus({ preventScroll: true });
    });

    return () => cancelAnimationFrame(frame);
  }, [activeRouteTitle, path]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const closeIfDesktop = () => {
      if (media.matches) {
        setSidebarOpen(false);
      }
    };

    closeIfDesktop();
    media.addEventListener("change", closeIfDesktop);

    return () => media.removeEventListener("change", closeIfDesktop);
  }, [setSidebarOpen]);

  return html`
    <div class="app-shell">
      <${Sidebar}
        open=${sidebarOpen}
        onToggle=${() => setSidebarOpen((value) => !value)}
        onNavigate=${() => setSidebarOpen(false)}
      />
      <main ref=${mainRef} class="app-main" tabindex="-1" aria-label=${activeRouteTitle} inert=${sidebarOpen ? true : null}>
        <${Router}>
          ${APP_ROUTES.map((route) => html`<${Route} key=${route.id} path=${route.path} component=${componentFor(route)} />`)}
          <${Route} default component=${NotFound} />
        <//>
      </main>
    </div>
  `;
}
