import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { ordinalSuffix } from "../../lib/format.js";
import { html } from "../../lib/html.js";
import { HttpError, http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

// Map libraries inherently need network (tiles), so unlike the app framework they are loaded lazily from
// their pinned CDNs the first time a key-backed map mounts, never bundled (REWRITE_PLAN §12.2, §13). The
// rest of the app must not depend on them: if injection fails (offline) the view degrades to an
// "unavailable" panel rather than crashing.
const MAPBOX_JS = "https://api.mapbox.com/mapbox-gl-js/v3.24.0/mapbox-gl.js";
const MAPBOX_CSS = "https://api.mapbox.com/mapbox-gl-js/v3.24.0/mapbox-gl.css";
const AMAP_LOADER = "https://webapi.amap.com/loader.js";
const MAP_STYLE = "mapbox://styles/frogsgomoo/cmcfv151j000o01rcdxebhl76";

// Searchbox/geocode tuning the old client used (navigation_destination.js / navigation_utilities.js).
const SEARCH_MIN_CHARS = 3;
const SEARCH_DEBOUNCE_MS = 800;
const SUGGEST_LIMIT = 4;
const ACTIVE_ROUTE_STORAGE_KEY = "activeRouteId";

// Congestion colors for the route line-gradient (REWRITE_PLAN §12.2 / navigation_utilities.js congestionToColor).
const CONGESTION_COLORS = { heavy: "#e67e22", low: "#2ecc71", moderate: "#f1c40f", severe: "#e74c3c", unknown: "#2ecc71" };
const SELECTED_LINE_WIDTH = 5;
const UNSELECTED_LINE_WIDTH = 3;
const CLICK_LAYER_WIDTH = 25;

let mapboxLoad;
let amapLoad;

// Inject a stylesheet once; resolves when it is in the document (link load is best-effort — the map still
// works if the CSS is slow, the tiles just style late).
function loadStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) {
    return;
  }

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

// Inject a script once and resolve when window[globalName] exists. Memoized via the module-level promise so
// repeated mounts reuse a single in-flight/loaded copy rather than re-injecting the tag.
function loadScript(src, globalName) {
  if (window[globalName]) {
    return Promise.resolve(window[globalName]);
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    const script = existing || document.createElement("script");
    const onLoad = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${globalName} did not load`)));

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });

    if (!existing) {
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

function loadMapbox() {
  if (!mapboxLoad) {
    loadStylesheet(MAPBOX_CSS);
    mapboxLoad = loadScript(MAPBOX_JS, "mapboxgl");
  }

  return mapboxLoad;
}

function loadAmap(apiKey, securityCode) {
  if (!amapLoad) {
    amapLoad = loadScript(AMAP_LOADER, "AMapLoader").then((loader) => {
      // AMap v2.0 needs both an API key and a security code (REWRITE_PLAN §12.2). The two stored AMap
      // fields map to key/securityJsCode; if the loader rejects (misconfigured/offline) the caller falls
      // back to the empty-suggestion path rather than crashing.
      window._AMapSecurityConfig = { securityJsCode: securityCode };
      return loader.load({ key: apiKey, version: "2.0", plugins: ["AMap.Autocomplete"] });
    });
  }

  return amapLoad;
}

function metersToHuman(meters, isMetric) {
  if (isMetric) {
    return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  }

  const feet = meters * 3.28084;
  return feet >= 5280 ? `${(feet / 5280).toFixed(1)} mi` : `${Math.round(feet)} ft`;
}

function secondsToHuman(seconds, isMetric) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours > 0) {
    return isMetric ? `${hours}h ${remainder} min` : `${hours} hr ${remainder} min`;
  }

  return `${remainder} min`;
}

function etaString(seconds) {
  const arrival = new Date(Date.now() + seconds * 1000);
  const timeStr = arrival.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (seconds <= 24 * 3600) {
    return timeStr;
  }

  const day = arrival.getDate();
  return `${arrival.toLocaleString([], { month: "long" })} ${day}${ordinalSuffix(day)}, ${arrival.getFullYear()}, ${timeStr}`;
}

function congestionColor(level) {
  return CONGESTION_COLORS[level] || "#999";
}

// Build the mapbox-gl line-gradient expression from a per-coordinate congestion annotation. Guards an
// empty congestion array (the crash site the old buildGradientExpression skipped).
function gradientExpression(coordinates, congestion) {
  const count = Array.isArray(congestion) ? congestion.length : 0;
  if (count === 0 || coordinates.length < 2) {
    return ["interpolate", ["linear"], ["line-progress"], 0, "#ccc", 1, "#ccc"];
  }

  const stops = [];
  for (let index = 0; index < count; index += 1) {
    stops.push(count === 1 ? 0 : index / (count - 1), congestionColor(congestion[index] || "unknown"));
  }

  return ["interpolate", ["linear"], ["line-progress"], ...stops];
}

function routeLabel(routeIndex) {
  return routeIndex === 0 ? "main" : `alt-${routeIndex}`;
}

async function fetchSuggestions(provider, query, context) {
  if (provider === "mapbox") {
    const params = new URLSearchParams({
      access_token: context.mapboxPublic,
      limit: String(SUGGEST_LIMIT),
      q: query,
      session_token: context.sessionToken,
    });
    if (context.center) {
      params.set("proximity", `${context.center.longitude},${context.center.latitude}`);
    }
    const response = await fetch(`https://api.mapbox.com/search/searchbox/v1/suggest?${params}`);
    const data = await response.json();
    return Array.isArray(data.suggestions) ? data.suggestions : [];
  }

  // AMap autocomplete is a callback API on the loaded SDK, not a REST endpoint (navigation_destination.js:314).
  return new Promise((resolve) => {
    const autocomplete = new context.amap.Autocomplete({ city: "auto" });
    autocomplete.search(query, (status, result) => {
      resolve(status === "complete" && result?.tips ? result.tips : []);
    });
  });
}

async function resolveSuggestion(provider, suggestion, context) {
  if (provider === "amap") {
    const location = suggestion.location;
    if (!location) {
      return null;
    }

    return { latitude: location.lat, longitude: location.lng, name: suggestion.name || suggestion.address || "" };
  }

  const name = suggestion.full_address || suggestion.name || suggestion.address || "";
  if (Array.isArray(suggestion.geometry?.coordinates)) {
    const [longitude, latitude] = suggestion.geometry.coordinates;
    return { latitude, longitude, name };
  }

  const url = new URL(`https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(suggestion.mapbox_id)}`);
  url.searchParams.set("access_token", context.mapboxPublic);
  url.searchParams.set("session_token", context.sessionToken);
  const response = await fetch(url);
  const data = await response.json();
  // Guard features[0] — a retrieve with no feature must not throw (REWRITE_PLAN §12.2 fidelity risk).
  const coordinates = data.features?.[0]?.geometry?.coordinates;
  return coordinates ? { latitude: coordinates[1], longitude: coordinates[0], name } : null;
}

async function fetchRoutes(from, to, mapboxPublic) {
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${from};${to}` +
    `?geometries=geojson&annotations=congestion&overview=full&alternatives=true&access_token=${mapboxPublic}`;
  const response = await fetch(url);
  const data = await response.json();
  return Array.isArray(data.routes) ? data.routes : [];
}

function suggestionName(suggestion) {
  return suggestion.full_address || suggestion.name || suggestion.address || "";
}

function RouteSummary({ route, isMetric, confirmed, busy, onStart, onCancel, onToggleFavorite }) {
  return html`
    <div class="nav-summary">
      <div class="nav-summary-title" title=${route.name}>${route.name}</div>
      ${route.routePreviewUnavailable
        ? html`<p class="nav-summary-note" role="status">${strings.navigation.routePreviewUnavailable}</p>`
        : html`
            <div class="nav-summary-row">
              <span class="nav-summary-label">${strings.navigation.distance}</span>
              <span class="nav-summary-value">${metersToHuman(route.distance, isMetric)}</span>
            </div>
            <div class="nav-summary-row">
              <span class="nav-summary-label">${strings.navigation.duration}</span>
              <span class="nav-summary-value">${secondsToHuman(route.duration, isMetric)}</span>
            </div>
            <div class="nav-summary-row">
              <span class="nav-summary-label">${strings.navigation.eta}</span>
              <span class="nav-summary-value">${etaString(route.duration)}</span>
            </div>
          `}
      <div class="nav-summary-actions">
        ${confirmed
          ? html`<button class="btn btn-danger" disabled=${busy} onClick=${onCancel}>
              <${Icon} name="close" /> <span>${strings.navigation.cancelNavigation}</span>
            </button>`
          : html`<button class="btn btn-primary" disabled=${busy} onClick=${onStart}>
              <${Icon} name="map-pin" /> <span>${strings.navigation.startNavigation}</span>
            </button>`}
        <button class="btn" disabled=${busy} onClick=${onToggleFavorite}>
          <${Icon} name=${route.isFavorited ? "trash" : "map-pin"} />
          <span>${route.isFavorited ? strings.navigation.unfavorite : strings.navigation.favorite}</span>
        </button>
      </div>
    </div>
  `;
}

function SuggestionList({ suggestions, isFavoritesView, onSelect, onRemove, onSetHome, onSetWork }) {
  return html`
    <ul class="nav-suggestions">
      ${suggestions.map(
        (suggestion, index) => html`
          <li key=${suggestion.id || suggestion.mapbox_id || `${suggestionName(suggestion)}-${index}`} class="nav-suggestion">
            <button class="nav-suggestion-main" onClick=${() => onSelect(suggestion)}>
              ${suggestion.is_home ? html`<span class="nav-tag">${strings.navigation.home}</span>` : null}
              ${suggestion.is_work ? html`<span class="nav-tag">${strings.navigation.work}</span>` : null}
              <span class="nav-suggestion-name">${suggestionName(suggestion)}</span>
            </button>
            ${isFavoritesView &&
            html`<div class="nav-suggestion-actions">
              <button
                class=${`icon-btn ${suggestion.is_home ? "is-active" : ""}`}
                aria-pressed=${suggestion.is_home}
                aria-label=${strings.navigation.setHome}
                onClick=${() => onSetHome(suggestion)}
              >
                <${Icon} name="home" />
              </button>
              <button
                class=${`icon-btn ${suggestion.is_work ? "is-active" : ""}`}
                aria-pressed=${suggestion.is_work}
                aria-label=${strings.navigation.setWork}
                onClick=${() => onSetWork(suggestion)}
              >
                <${Icon} name="map" />
              </button>
              <button class="icon-btn" aria-label=${strings.navigation.favoriteRemove} onClick=${() => onRemove(suggestion)}>
                <${Icon} name="trash" />
              </button>
            </div>`}
          </li>
        `,
      )}
    </ul>
  `;
}

export function NavigationDestination() {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [needsKeys, setNeedsKeys] = useState(false);
  const [mapUnavailable, setMapUnavailable] = useState(false);

  const [provider, setProvider] = useState("mapbox");
  const [canToggleProvider, setCanToggleProvider] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [favoritesView, setFavoritesView] = useState(false);
  const [favorites, setFavorites] = useState([]);

  const [selectedRoute, setSelectedRoute] = useState(null);
  const [confirmedRoute, setConfirmedRoute] = useState(null);
  const [routing, setRouting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState(null);

  const mapContainerRef = useRef(null);
  const stateRef = useRef({});
  const handlersRef = useRef({});
  const debounceRef = useRef(null);

  // The latest closures/state the long-lived map event handlers read. Keeping them in refs lets the
  // mount-only teardown effect (below) reference current values without re-subscribing (B3 §3.4 pattern).
  // MERGE (not replace): stateRef also holds imperative handles the setup effect stores (map, mapboxgl,
  // destinationMarker, routes, center, sessionToken). A full reassignment on every render would wipe them,
  // so the unmount cleanup would find no map to remove (a real teardown leak) and mid-session map
  // interactions would break. Object.assign preserves those handles while refreshing the reactive snapshot.
  Object.assign(stateRef.current, { canToggleProvider, confirmedRoute, favorites, provider, selectedRoute });

  const clearDestinationMarker = () => {
    const refs = stateRef.current;
    if (refs.destinationMarker) {
      refs.destinationMarker.remove();
      refs.destinationMarker = null;
    }
  };

  const removeRouteLayers = () => {
    const map = stateRef.current.map;
    if (!map || !map.getStyle?.()) {
      return;
    }

    for (const layer of map.getStyle().layers || []) {
      if ((layer.id.startsWith("route-line-") || layer.id.startsWith("route-click-")) && map.getLayer(layer.id)) {
        map.removeLayer(layer.id);
      }
    }
    for (const sourceId of Object.keys(map.getStyle().sources || {})) {
      if (sourceId.startsWith("route-") && map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }
    }
  };

  const highlightRoute = (routeId) => {
    const refs = stateRef.current;
    const map = refs.map;
    if (!map || !map.isStyleLoaded() || !refs.routes) {
      return;
    }

    refs.routes.forEach((route, index) => {
      const layerId = `route-line-${routeLabel(index)}`;
      if (!map.getLayer(layerId)) {
        return;
      }

      const isSelected = routeLabel(index) === routeId;
      map.setPaintProperty(layerId, "line-width", isSelected ? SELECTED_LINE_WIDTH : UNSELECTED_LINE_WIDTH);
      map.setPaintProperty(layerId, "line-opacity", isSelected ? 1 : 0.5);
      if (isSelected) {
        map.moveLayer(layerId);
      }
    });
  };

  const buildRoute = (route, routeId, name, destination) => ({
    destination,
    distance: route.distance,
    duration: route.duration,
    isFavorited: handlersRef.current.isFavorited?.(destination) || false,
    name,
    routeId,
  });

  const buildDestinationOnlyRoute = (destination) => {
    const coordinates = [destination.longitude, destination.latitude];
    return {
      destination: coordinates,
      isFavorited: handlersRef.current.isFavorited?.(coordinates) || false,
      name: destination.name,
      routeId: `destination-${destination.longitude},${destination.latitude}`,
      routePreviewUnavailable: true,
    };
  };

  const showDestinationOnlyRoute = (destination, { resume = false } = {}) => {
    const refs = stateRef.current;
    const coordinates = [destination.longitude, destination.latitude];
    const route = buildDestinationOnlyRoute(destination);

    removeRouteLayers();
    clearDestinationMarker();
    if (refs.map && refs.mapboxgl) {
      refs.destinationMarker = new refs.mapboxgl.Marker().setLngLat(coordinates).addTo(refs.map);
      refs.map.flyTo?.({ center: coordinates, pitch: 45, zoom: 18 });
    }

    setSelectedRoute(route);
    setConfirmedRoute(resume ? route : null);
    setSuggestions([]);
    setFavoritesView(false);
    setRouting(false);
  };

  const drawRoutes = (routes, start, destinationCoordinates, name) => {
    const map = stateRef.current.map;
    stateRef.current.routes = routes;
    removeRouteLayers();

    routes.forEach((route, index) => {
      const routeId = routeLabel(index);
      const sourceId = `route-${routeId}`;
      const lineLayerId = `route-line-${routeId}`;
      const clickLayerId = `route-click-${routeId}`;
      const coordinates = route.geometry.coordinates;

      map.addSource(sourceId, {
        data: {
          features: [{ geometry: { coordinates, type: "LineString" }, properties: { routeId }, type: "Feature" }],
          type: "FeatureCollection",
        },
        lineMetrics: true,
        type: "geojson",
      });
      map.addLayer({
        id: lineLayerId,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-gradient": gradientExpression(coordinates, route.legs?.[0]?.annotation?.congestion),
          "line-opacity": 0.5,
          "line-width": UNSELECTED_LINE_WIDTH,
        },
        source: sourceId,
        type: "line",
      });
      // An invisible wide line gives a forgiving tap/click target for selecting an alternative route.
      map.addLayer({
        id: clickLayerId,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-opacity": 0, "line-width": CLICK_LAYER_WIDTH },
        source: sourceId,
        type: "line",
      });

      map.on("click", clickLayerId, () => {
        setSelectedRoute(buildRoute(route, routeId, name, destinationCoordinates));
        highlightRoute(routeId);
      });
    });

    map.once("idle", () => highlightRoute(stateRef.current.selectedRoute?.routeId ?? "main"));

    const padding = window.innerWidth < 600 ? 100 : 250;
    map.fitBounds([start, destinationCoordinates], { duration: 1000, padding });
  };

  const startRouting = async (destination, { resume = false } = {}) => {
    const refs = stateRef.current;
    const center = refs.center;
    if (!refs.map || !center) {
      showDestinationOnlyRoute(destination, { resume });
      return;
    }

    setSelectedRoute(null);
    if (!resume) {
      setConfirmedRoute(null);
    }
    setRouting(true);
    clearDestinationMarker();

    try {
      const coordinates = [destination.longitude, destination.latitude];
      refs.destinationMarker = new refs.mapboxgl.Marker().setLngLat(coordinates).addTo(refs.map);

      const routes = await fetchRoutes(
        `${center.longitude},${center.latitude}`,
        `${coordinates[0]},${coordinates[1]}`,
        refs.mapboxPublic,
      );
      if (routes.length === 0) {
        return;
      }

      drawRoutes(routes, [center.longitude, center.latitude], coordinates, destination.name);

      const route = buildRoute(routes[0], "main", destination.name, coordinates);
      setSelectedRoute(route);
      if (resume) {
        setConfirmedRoute(route);
      }
      setSuggestions([]);
      setFavoritesView(false);
    } catch (error) {
      console.error("Failed to calculate route", error);
      showToast(strings.navigation.routeCalcFailed, "error");
    } finally {
      setRouting(false);
    }
  };

  const setup = useRef(async (data) => {
    const mapboxPublic = (data.mapboxPublic || "").trim();
    const hasMapbox = Boolean(mapboxPublic && data.hasMapboxSecret);

    setCanToggleProvider(false);
    setProvider(hasMapbox ? "mapbox" : "amap");

    if (!hasMapbox) {
      setNeedsKeys(true);
      setLoading(false);
      return;
    }

    const center = null;
    Object.assign(stateRef.current, { center, isMetric: Boolean(data.isMetric), mapboxPublic });

    let mapboxgl;
    try {
      mapboxgl = await loadMapbox();
    } catch {
      // The map needs network; offline the rest of the view (favorites, search results) must still work.
      setMapUnavailable(true);
      setLoading(false);
      await handlersRef.current.loadFavorites?.();
      return;
    }

    stateRef.current.mapboxgl = mapboxgl;
    if (!mapContainerRef.current) {
      setLoading(false);
      return;
    }

    mapboxgl.accessToken = mapboxPublic;
    // Fall back to the saved destination or a neutral center when no GPS fix is present (the old code
    // assumed lastPosition existed and crashed on a freshly-parked device — B4 brief fidelity risk).
    let saved = null;
    try {
      saved = data.destination ? JSON.parse(data.destination) : null;
    } catch {
      saved = null;
    }
    const initialCenter = center ? [center.longitude, center.latitude] : saved ? [saved.longitude, saved.latitude] : [0, 0];

    const map = new mapboxgl.Map({
      attributionControl: false,
      center: initialCenter,
      container: mapContainerRef.current,
      logoPosition: "bottom-right",
      pitch: 45,
      style: MAP_STYLE,
      zoom: 15,
    });
    stateRef.current.map = map;
    new mapboxgl.Marker().setLngLat(initialCenter).addTo(map);

    map.on("style.load", () => {
      // Insert 3D building extrusions beneath the first symbol (label) layer. Guard the label lookup —
      // a style with no text-field symbol layer must not throw (REWRITE_PLAN §12.2 fidelity risk).
      const labelLayer = map.getStyle().layers.find((layer) => layer.type === "symbol" && layer.layout?.["text-field"]);
      map.addLayer(
        {
          id: "add-3d-buildings",
          minzoom: 15,
          paint: {
            "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.05, ["get", "min_height"]],
            "fill-extrusion-color": "#aaa",
            "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.05, ["get", "height"]],
            "fill-extrusion-opacity": 0.6,
          },
          source: "composite",
          "source-layer": "building",
          type: "fill-extrusion",
          filter: ["==", "extrude", "true"],
        },
        labelLayer?.id,
      );
    });

    map.on("load", () => {
      map.flyTo({ center: initialCenter, pitch: 45, zoom: 18 });
      if (saved && stateRef.current.center) {
        handlersRef.current.startRouting?.(saved, { resume: true });
      }
    });

    setLoading(false);
    await handlersRef.current.loadFavorites?.();
  });

  const loadFavorites = async () => {
    try {
      const data = await http.get("/api/navigation/favorite");
      const sorted = [...data.favorites].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setFavorites(sorted);
      return sorted;
    } catch (error) {
      showToast(messageFor(error, strings.navigation.loadFailed), "error");
      return [];
    }
  };

  const isFavorited = (coordinates) =>
    stateRef.current.favorites.some((favorite) => favorite.latitude === coordinates[1] && favorite.longitude === coordinates[0]);

  // Expose the live handlers to the map setup/event closures captured at mount (refs avoid re-binding).
  handlersRef.current = { isFavorited, loadFavorites, startRouting };

  const runSearch = async (value) => {
    const trimmed = value.trim();
    if (trimmed.length < SEARCH_MIN_CHARS) {
      if (trimmed.length === 0) {
        setSuggestions([]);
      }
      return;
    }

    const refs = stateRef.current;
    setSelectedRoute(null);
    setSuggestions([]);
    setFavoritesView(false);

    try {
      const context = { amap: refs.amap, center: refs.center, mapboxPublic: refs.mapboxPublic, sessionToken: refs.sessionToken };
      if (refs.provider === "amap" && !refs.amap) {
        refs.amap = await loadAmap(refs.amap1, refs.amap2);
        context.amap = refs.amap;
      }

      setSuggestions(await fetchSuggestions(refs.provider, trimmed, context));
    } catch (error) {
      console.error("Search failed", error);
      showToast(strings.navigation.routeCalcFailed, "error");
    }
  };

  const onSearchInput = (event) => {
    const value = event.target.value;
    setQuery(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(value), SEARCH_DEBOUNCE_MS);
  };

  const onSearchKeyDown = (event) => {
    if (event.key === "Enter") {
      clearTimeout(debounceRef.current);
      runSearch(event.target.value);
    }
  };

  const selectSuggestion = async (suggestion) => {
    if (suggestion.routeId !== undefined && suggestion.latitude != null && suggestion.longitude != null) {
      // A favorite row carries its own coordinates; route to it directly.
      await startRouting({ latitude: suggestion.latitude, longitude: suggestion.longitude, name: suggestion.name });
      return;
    }

    setRouting(true);
    try {
      const resolved = await resolveSuggestion(stateRef.current.provider, suggestion, stateRef.current);
      if (!resolved) {
        throw new Error("Could not determine location");
      }

      await startRouting(resolved);
    } catch (error) {
      console.error("Could not determine location", error);
      showToast(strings.navigation.routeCalcFailed, "error");
      setRouting(false);
    }
  };

  const showFavorites = async () => {
    if (favoritesView) {
      setFavoritesView(false);
      setSuggestions([]);
      return;
    }

    setQuery("");
    setSelectedRoute(null);
    setConfirmedRoute(null);
    setSuggestions(await loadFavorites());
    setFavoritesView(true);
  };

  const startNavigation = async () => {
    const route = selectedRoute;
    if (!route || busy) {
      return;
    }

    setBusy(true);
    try {
      await http.post("/api/navigation", { latitude: route.destination[1], longitude: route.destination[0], name: route.name });
      localStorage.setItem(ACTIVE_ROUTE_STORAGE_KEY, route.routeId);
      setConfirmedRoute(route);
      showToast(strings.navigation.navigationSet);
      await loadFavorites();
    } catch (error) {
      showToast(messageFor(error, strings.navigation.routeCalcFailed), "error");
    } finally {
      setBusy(false);
    }
  };

  const cancelNavigation = async () => {
    if (busy) {
      return;
    }

    setBusy(true);
    try {
      await http.del("/api/navigation");
      localStorage.removeItem(ACTIVE_ROUTE_STORAGE_KEY);
      removeRouteLayers();
      clearDestinationMarker();
      setSelectedRoute(null);
      setConfirmedRoute(null);
      showToast(strings.navigation.navigationCancelled);
    } catch (error) {
      showToast(messageFor(error, strings.navigation.loadFailed), "error");
    } finally {
      setBusy(false);
    }
  };

  const toggleFavorite = async () => {
    const route = selectedRoute;
    if (!route || busy) {
      return;
    }

    if (route.isFavorited) {
      const existing = favorites.find(
        (favorite) => favorite.latitude === route.destination[1] && favorite.longitude === route.destination[0],
      );
      if (existing) {
        setPendingRemove(existing);
      }
      return;
    }

    setBusy(true);
    try {
      await http.post("/api/navigation/favorite", {
        latitude: route.destination[1],
        longitude: route.destination[0],
        name: route.name,
        routeId: route.routeId,
      });
      showToast(strings.navigation.favoriteAdded);
      await loadFavorites();
      setSelectedRoute({ ...route, isFavorited: true });
    } catch (error) {
      const message =
        error instanceof HttpError && error.status === 409
          ? strings.navigation.favoriteAdded
          : messageFor(error, strings.navigation.favoriteAddFailed);
      showToast(message, error instanceof HttpError && error.status === 409 ? "info" : "error");
    } finally {
      setBusy(false);
    }
  };

  const removeFavorite = async (favorite) => {
    setPendingRemove(null);
    try {
      await http.del("/api/navigation/favorite", { body: { id: favorite.id } });
      showToast(strings.navigation.favoriteRemoved);
      const sorted = await loadFavorites();
      if (favoritesView) {
        setSuggestions(sorted);
      }
    } catch (error) {
      showToast(messageFor(error, strings.navigation.favoriteRemoveFailed), "error");
    }
  };

  const setSpecial = async (favorite, field) => {
    const enabling = !favorite[field];
    try {
      await http.post("/api/navigation/favorite/rename", { [field]: enabling, id: favorite.id });
      const setMsg = field === "is_home" ? strings.navigation.homeSet : strings.navigation.workSet;
      const clearMsg = field === "is_home" ? strings.navigation.homeRemoved : strings.navigation.workRemoved;
      showToast(enabling ? setMsg : clearMsg);
      const sorted = await loadFavorites();
      if (favoritesView) {
        setSuggestions(sorted);
      }
    } catch (error) {
      showToast(messageFor(error, strings.navigation.favoriteRenameFailed), "error");
    }
  };

  // Mount-only load + teardown. The map holds tiles, animation frames, and event listeners; map.remove()
  // releases all of them, the debounce timer is cleared, and the markers are dropped, so navigating away
  // leaves nothing running (CONVENTIONS §11, asserted by the leak spec). Latest handlers are read via refs.
  useEffect(() => {
    stateRef.current.sessionToken = crypto.randomUUID?.() || Math.random().toString(36).slice(2);

    let active = true;
    http
      .get("/api/navigation")
      .then((data) => {
        if (active) {
          setup.current(data);
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setLoading(false);
        }
      });

    return () => {
      active = false;
      clearTimeout(debounceRef.current);
      const refs = stateRef.current;
      if (refs.destinationMarker) {
        refs.destinationMarker.remove();
      }
      if (refs.map) {
        refs.map.remove();
        refs.map = null;
      }
    };
  }, []);

  const placeholder = renderPlaceholder(failed, loading);

  if (needsKeys) {
    return html`
      <section class="navigation">
        <div class="nav-keys-required">
          <h2 class="nav-keys-required-title">${strings.navigation.mapboxKeysRequired}</h2>
          <p class="nav-keys-required-text">${strings.navigation.mapboxKeysRequiredText}</p>
          <a class="btn btn-primary" href="/manage_navigation_keys"
            ><${Icon} name="key" /> <span>${strings.navigation.keysTitle}</span></a
          >
        </div>
      </section>
    `;
  }

  return html`
    <section class="navigation">
      <div class="nav-search-panel">
        <div class="nav-search-row">
          <input
            class="nav-search-input"
            type="text"
            autocomplete="off"
            placeholder=${strings.navigation.searchPlaceholder}
            aria-label=${strings.navigation.searchPlaceholder}
            value=${query}
            onInput=${onSearchInput}
            onKeyDown=${onSearchKeyDown}
          />
          ${favorites.length > 0 &&
          html`<button class=${`btn ${favoritesView ? "btn-primary" : ""}`} onClick=${showFavorites}>
            <${Icon} name="map-pin" /> <span>${strings.navigation.favorites}</span>
          </button>`}
          ${canToggleProvider &&
          html`<div class="nav-provider-toggle" role="group" aria-label=${strings.navigation.providerMapbox}>
            <button
              class=${`btn ${provider === "mapbox" ? "btn-primary" : ""}`}
              aria-pressed=${provider === "mapbox"}
              onClick=${() => {
                setProvider("mapbox");
                setSuggestions([]);
              }}
            >
              ${strings.navigation.providerMapbox}
            </button>
            <button
              class=${`btn ${provider === "amap" ? "btn-primary" : ""}`}
              aria-pressed=${provider === "amap"}
              onClick=${() => {
                setProvider("amap");
                setSuggestions([]);
              }}
            >
              ${strings.navigation.providerAmap}
            </button>
          </div>`}
        </div>

        ${placeholder && html`<p class="nav-message">${placeholder}</p>`}
        ${mapUnavailable && html`<p class="nav-message">${strings.navigation.mapUnavailable}</p>`}
        ${routing && html`<p class="nav-message" role="status">${strings.navigation.routeCalculating}</p>`}
        ${!routing &&
        selectedRoute &&
        html`<${RouteSummary}
          route=${selectedRoute}
          isMetric=${Boolean(stateRef.current.isMetric)}
          confirmed=${confirmedRoute?.routeId === selectedRoute.routeId &&
          confirmedRoute?.destination?.[0] === selectedRoute.destination?.[0] &&
          confirmedRoute?.destination?.[1] === selectedRoute.destination?.[1]}
          busy=${busy}
          onStart=${startNavigation}
          onCancel=${cancelNavigation}
          onToggleFavorite=${toggleFavorite}
        />`}
        ${!routing &&
        !selectedRoute &&
        suggestions.length > 0 &&
        html`<${SuggestionList}
          suggestions=${suggestions}
          isFavoritesView=${favoritesView}
          onSelect=${selectSuggestion}
          onRemove=${(favorite) => setPendingRemove(favorite)}
          onSetHome=${(favorite) => setSpecial(favorite, "is_home")}
          onSetWork=${(favorite) => setSpecial(favorite, "is_work")}
        />`}
      </div>

      <div class="nav-map" ref=${mapContainerRef}></div>

      ${pendingRemove &&
      html`<${Modal}
        title=${strings.navigation.favoriteRemoveConfirmTitle}
        message=${strings.navigation.favoriteRemoveConfirm(pendingRemove.name)}
        confirmLabel=${strings.navigation.favoriteRemove}
        danger
        onConfirm=${() => removeFavorite(pendingRemove)}
        onCancel=${() => setPendingRemove(null)}
      />`}
    </section>
  `;
}

function renderPlaceholder(failed, loading) {
  if (failed) {
    return strings.navigation.loadFailed;
  }

  if (loading) {
    return strings.navigation.loading;
  }

  return null;
}
