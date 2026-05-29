import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useLocation } from "preact-iso";

import { Icon } from "./Icon.js";
import { SidebarGroup } from "./SidebarGroup.js";
import { SidebarResults } from "./SidebarResults.js";
import { SidebarSearch } from "./SidebarSearch.js";
import { FOCUSABLE, trapFocus } from "../lib/focus_trap.js";
import { html } from "../lib/html.js";
import { http } from "../lib/http.js";
import { readPref, writePref } from "../lib/prefs.js";
import { NAV_ROUTES, NAV_SECTION_KEYS } from "../lib/route_manifest.js";
import { lockScroll, unlockScroll } from "../lib/scroll_lock.js";
import { buildSearchIndex } from "../lib/search_index.js";
import { strings } from "../lib/strings.js";

// The route manifest owns the information architecture: everyday use first (Home, Navigation, Recordings),
// then configuration (Settings, Personalization, Vehicle), then maintenance + connectivity. Items carrying
// a `flag` are conditional and render only when the matching availability fetch returns true.
const NAV_SECTIONS = NAV_SECTION_KEYS.map((sectionKey) => ({
  section: strings.sections[sectionKey],
  sectionKey,
  items: NAV_ROUTES.filter((route) => route.sectionKey === sectionKey).map((route) => ({
    flag: route.availabilityFlag,
    href: route.path,
    icon: route.icon,
    label: strings.nav[route.labelKey],
    searchTags: route.searchTags ?? [],
  })),
})).filter((group) => group.items.length > 0);

// Every section is short enough to start expanded; users can fold any of them and the choice persists.
// Persisted folds use route-manifest section keys so label copy can change without invalidating state.
const PROBE_TIMEOUT_MS = 5000;

const currentBrowserPath = (fallback) => (typeof window === "undefined" ? fallback : window.location.pathname);
const isGroupCollapsed = (group, activeSectionKey, collapsed) =>
  group.sectionKey === activeSectionKey ? false : Boolean(collapsed[group.sectionKey]);
const sectionOf = (path) => NAV_SECTIONS.find((group) => group.items.some((item) => item.href === path));

function timeoutSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, timeoutMs);

  if (parentSignal?.aborted) {
    abort();
  } else {
    parentSignal?.addEventListener("abort", abort, { once: true });
  }

  return {
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    },
    signal: controller.signal,
  };
}

// One-shot gate fetch for the conditional Tools items (doors/tsk). A probe that errors or times out
// resolves to `null` ("unknown"): we keep the last-known value rather than caching a stale `false`, so a
// flaky link can't permanently hide Doors/TSK until storage is cleared.
function useFeatureAvailability() {
  const [available, setAvailable] = useState(() => readPref("sidebar.available", { doorsAvailable: false, tskAvailable: false }));

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    const probe = async (url) => {
      const scopedSignal = timeoutSignal(controller.signal, PROBE_TIMEOUT_MS);
      try {
        const data = await http.get(url, { signal: scopedSignal.signal });
        return Boolean(data && data.result);
      } catch {
        return null;
      } finally {
        scopedSignal.cleanup();
      }
    };

    (async () => {
      const [doors, tsk] = await Promise.all([probe("/api/doors_available"), probe("/api/tsk_available")]);
      if (!active) {
        return;
      }
      setAvailable((prev) => {
        const next = {
          doorsAvailable: doors === null ? prev.doorsAvailable : doors,
          tskAvailable: tsk === null ? prev.tskAvailable : tsk,
        };
        writePref("sidebar.available", next);
        return next;
      });
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return available;
}

// Build the content search index on demand. No module-level cache — each engagement rebuilds, so an item
// added mid-session shows up, and a failed/empty build still flips `loaded` so the empty state can appear.
function useContentIndex() {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const building = useRef(false);
  const controller = useRef(null);

  const abort = () => {
    controller.current?.abort();
    controller.current = null;
    building.current = false;
  };

  useEffect(() => abort, []);

  const ensure = () => {
    if (building.current) {
      return;
    }
    const run = new AbortController();
    controller.current = run;
    building.current = true;
    setLoaded(false);
    buildSearchIndex({ signal: run.signal })
      .then((result) => {
        if (!run.signal.aborted) {
          setEntries(result);
        }
      })
      .catch(() => {
        if (!run.signal.aborted) {
          setEntries([]);
        }
      })
      .finally(() => {
        if (controller.current !== run) {
          return;
        }
        controller.current = null;
        building.current = false;
        if (!run.signal.aborted) {
          setLoaded(true);
        }
      });
  };

  return { abort, entries, loaded, ensure };
}

// Make the open mobile drawer behave as a modal dialog: trap focus, lock scroll, Escape to close, and
// restore focus on close. On desktop the sidebar is always visible and `open` stays false, so this is inert.
function useDrawerDialog(open, ref, onClose, restoreFocusTarget) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const previousFocus = restoreFocusTarget.current ?? document.activeElement;
    lockScroll();
    // Move focus into the drawer on open — but only if it isn't already inside (e.g. the user focused the
    // search field immediately), so we never yank focus out from under an in-progress interaction.
    if (!ref.current?.contains(document.activeElement)) {
      ref.current?.querySelector(FOCUSABLE)?.focus();
    }

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      } else if (event.key === "Tab") {
        trapFocus(event, ref.current);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unlockScroll();
      requestAnimationFrame(() => {
        if (
          previousFocus?.isConnected &&
          previousFocus.getClientRects().length > 0 &&
          (document.activeElement === document.body || ref.current?.contains(document.activeElement))
        ) {
          previousFocus.focus();
        }
      });
    };
  }, [open]);
}

function createMatchedEntries(searching, term, groups, contentEntries) {
  if (!searching) {
    return [];
  }
  const matches = (label) => label.toLowerCase().includes(term);
  const matchesItem = (item) => matches(item.label) || (item.searchTags ?? []).some((tag) => matches(tag));
  return [
    ...groups
      .flatMap((group) => group.items)
      .filter(matchesItem)
      .map((item) => ({ label: item.label, type: strings.nav.searchPage, href: item.href })),
    ...contentEntries.filter((entry) => matches(entry.label)),
  ];
}

export function Sidebar({ open, onToggle, onNavigate }) {
  const { path } = useLocation();
  const currentPath = currentBrowserPath(path);
  const available = useFeatureAvailability();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(() => {
    const stored = readPref("sidebar.collapsed", null);
    const valid = stored && typeof stored === "object" && !Array.isArray(stored);
    const initial = valid ? { ...stored } : {};
    const activeSectionKey = sectionOf(currentPath)?.sectionKey;
    if (activeSectionKey) {
      initial[activeSectionKey] = false;
    }
    return initial;
  });
  const { abort: abortIndex, entries: contentEntries, loaded: indexLoaded, ensure: ensureIndex } = useContentIndex();
  const drawerTrigger = useRef(null);
  const searchInput = useRef(null);
  const sidebarRef = useRef(null);

  useDrawerDialog(open, sidebarRef, onNavigate, drawerTrigger);

  useEffect(() => {
    if (!open) {
      abortIndex();
    }
  }, [open]);

  // Only an explicit header toggle is persisted; the active-route auto-open (the useState initializer
  // above) stays transient so "Tools folded by default" survives navigating through it.
  const toggleGroup = (section) => {
    const next = { ...collapsed, [section]: !collapsed[section] };
    writePref("sidebar.collapsed", next);
    setCollapsed(next);
  };

  // Clicking anywhere in the search field (including the icon) focuses the input.
  const activateSearch = () => {
    searchInput.current?.focus();
  };

  const term = query.trim().toLowerCase();
  const searching = term.length > 0;
  const groups = useMemo(
    () =>
      NAV_SECTIONS.map((group) => ({
        section: group.section,
        sectionKey: group.sectionKey,
        items: group.items.filter((item) => !item.flag || available[item.flag]),
      })).filter((group) => group.items.length > 0),
    [available],
  );

  // While searching, the sidebar becomes a flat command palette of matching pages + in-app content; the
  // grouped nav is swapped out entirely below, so folded sections never animate as the query changes.
  const matched = useMemo(
    () => createMatchedEntries(searching, term, groups, contentEntries),
    [searching, term, groups, contentEntries],
  );
  const indexLoading = searching && !indexLoaded && matched.length === 0;
  const noResults = searching && indexLoaded && matched.length === 0;
  const activeSectionKey = sectionOf(currentPath)?.sectionKey;

  return html`
    <button
      class="sidebar-toggle"
      aria-label=${strings.nav.menu}
      aria-expanded=${open}
      aria-hidden=${open ? "true" : null}
      tabindex=${open ? "-1" : null}
      onClick=${(event) => {
        drawerTrigger.current = event.currentTarget;
        onToggle();
      }}
    >
      <${Icon} name="menu" />
    </button>
    <div class=${`sidebar-underlay ${open ? "is-visible" : ""}`} onClick=${onNavigate}></div>
    <nav
      ref=${sidebarRef}
      class=${`sidebar ${open ? "is-open" : ""}`}
      aria-label=${strings.nav.primary}
      role=${open ? "dialog" : null}
      aria-modal=${open ? "true" : null}
    >
      <div class="sidebar-top">
        <a class="sidebar-brand" href="/" aria-label=${strings.app.name} onClick=${onNavigate}>
          <span class="sidebar-brand-logo" aria-hidden="true"></span>
          <span class="sidebar-brand-text">${strings.app.name}</span>
        </a>
        <button class="sidebar-close" type="button" aria-label=${strings.nav.closeMenu} onClick=${onToggle}>
          <${Icon} name="close" />
        </button>
      </div>
      <${SidebarSearch}
        inputRef=${searchInput}
        query=${query}
        onInput=${(event) => setQuery(event.target.value)}
        onActivate=${activateSearch}
        onFocus=${ensureIndex}
        searching=${searching}
        resultCount=${matched.length}
      />
      <div class="sidebar-scroll">
        ${searching
          ? html`
              <${SidebarResults}
                title=${strings.nav.searchResults}
                matches=${matched}
                emptyMessage=${indexLoading ? strings.nav.searchLoading : noResults ? strings.nav.searchEmpty : null}
                onNavigate=${onNavigate}
              />
            `
          : groups.map(
              (group) => html`
                <${SidebarGroup}
                  key=${group.section}
                  group=${group}
                  collapsed=${isGroupCollapsed(group, activeSectionKey, collapsed)}
                  path=${currentPath}
                  onToggle=${() => toggleGroup(group.sectionKey)}
                  onNavigate=${onNavigate}
                />
              `,
            )}
      </div>
    </nav>
  `;
}
