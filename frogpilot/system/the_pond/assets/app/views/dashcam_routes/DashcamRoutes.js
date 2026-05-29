import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { formatTimestamp } from "../../lib/format.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { lockScroll, unlockScroll } from "../../lib/scroll_lock.js";
import { openStream } from "../../lib/sse.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

// The forward road camera is the default angle and the one the overlay opens on; the labels for the
// three angles the server may report via available_cameras (config.CAMERA_FILES keys).
const DEFAULT_CAMERA = "forward";
const CAMERA_LABELS = {
  driver: strings.dashcamRoutes.cameraDriver,
  forward: strings.dashcamRoutes.cameraForward,
  wide: strings.dashcamRoutes.cameraWide,
};

// Matches a datetime.isoformat() string (the recorded start time); anything else is a verbatim custom
// name the user set, which is shown as-is (REWRITE_PLAN §4.3, §12.3).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function formatRouteDate(date) {
  if (!date) {
    return strings.dashcamRoutes.untitled;
  }

  // An ISO timestamp formats through the shared helper (it takes epoch seconds); a custom sentinel name
  // is not a date and is shown verbatim with its underscores turned back into spaces.
  return ISO_DATE.test(date) ? formatTimestamp(Date.parse(date) / 1000) : date.replace(/_/g, " ");
}

function downloadName(route, camera) {
  // An explicit download filename: the combined route streams inline with no Content-Disposition, so the
  // <a download> value names the file. Spaces/slashes from a custom name are normalised to underscores.
  const base = formatRouteDate(route.date).replace(/[^\w.-]+/g, "_") || route.name;
  return `${base}-${camera}.mp4`;
}

function RouteCard({ route, onOpen, onTogglePreserve }) {
  const [armed, setArmed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [gifReady, setGifReady] = useState(false);
  const label = formatRouteDate(route.date);

  // Preload the hover gif (built server-side on first request) once the card is first hovered, and only
  // swap it in after it has actually loaded so the still never flashes a broken image.
  useEffect(() => {
    if (!armed || gifReady) {
      return undefined;
    }

    const image = new Image();
    const onLoad = () => setGifReady(true);
    const onError = () => setArmed(false);
    image.addEventListener("load", onLoad);
    image.addEventListener("error", onError);
    image.src = route.gif;

    return () => {
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
    };
  }, [armed, gifReady, route.gif]);

  return html`
    <div class="route-card">
      <button
        class="route-open"
        onClick=${onOpen}
        onMouseEnter=${() => {
          setArmed(true);
          setHovering(true);
        }}
        onMouseLeave=${() => setHovering(false)}
      >
        <div class="route-thumb">
          <img class="route-img" src=${route.png} alt=${label} loading="lazy" />
          ${armed &&
          gifReady &&
          html`<img class=${`route-img route-gif ${hovering ? "is-visible" : ""}`} src=${route.gif} alt="" />`}
        </div>
        <span class="route-name">${label}</span>
      </button>
      <button
        class=${`route-preserve ${route.is_preserved ? "is-preserved" : ""}`}
        aria-label=${route.is_preserved ? strings.dashcamRoutes.unpreserve : strings.dashcamRoutes.preserve}
        aria-pressed=${route.is_preserved}
        onClick=${onTogglePreserve}
      >
        ${route.is_preserved ? strings.dashcamRoutes.preservedShort : strings.dashcamRoutes.preserveShort}
      </button>
    </div>
  `;
}

function RouteOverlay({ route, detail, failed, onClose, onRename, onClearName, onDelete }) {
  const cameras = detail?.available_cameras?.length ? detail.available_cameras : [DEFAULT_CAMERA];
  const [camera, setCamera] = useState(cameras.includes(DEFAULT_CAMERA) ? DEFAULT_CAMERA : cameras[0]);
  const [segmentIndex, setSegmentIndex] = useState(0);

  const videoRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Mount-only: keeping the <video> teardown out of the dependency list means a parent re-render (routes
  // still streaming in behind the overlay) cannot re-run the cleanup and kill in-flight playback. The
  // latest onClose is read via a ref (REWRITE_PLAN §3.4, §12.3).
  useEffect(() => {
    lockScroll();

    const onKeyDown = (event) => {
      // Ignore Escape while a modal is layered above, so it closes only the top layer.
      if (event.key === "Escape" && !document.querySelector(".modal-overlay")) {
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      unlockScroll();

      // Stop playback and abort any in-flight Range requests so a closed overlay leaves no <video>
      // streaming the route in the background (REWRITE_PLAN §3.4, §12.3).
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, []);

  // Once the detail resolves, snap the camera to the first one this route actually recorded if the
  // default (forward) is not among them, so the <video> never requests a camera the route lacks.
  useEffect(() => {
    if (detail?.available_cameras?.length && !detail.available_cameras.includes(camera)) {
      setCamera(detail.available_cameras[0]);
    }
  }, [detail, camera]);

  const segments = detail?.segment_urls ?? [];
  const segmentUrl = segments.length ? `${segments[segmentIndex]}?camera=${encodeURIComponent(camera)}` : null;

  // Auto-advance through the route: when one segment ends, roll on to the next so the whole drive plays
  // back continuously without the old race that dropped the final segment (REWRITE_PLAN §12.3).
  const onEnded = () => setSegmentIndex((index) => (index + 1 < segments.length ? index + 1 : index));

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="overlay-panel" onClick=${(event) => event.stopPropagation()}>
        <div class="overlay-head">
          <span class="overlay-title">${formatRouteDate(route.date)}</span>
          <button class="icon-btn" aria-label=${strings.dashcamRoutes.rename} onClick=${onRename}>
            <${Icon} name="edit" />
          </button>
        </div>

        ${failed
          ? html`<p class="overlay-message">${strings.dashcamRoutes.videoError}</p>`
          : detail === null
            ? html`<p class="overlay-message">${strings.dashcamRoutes.loadingVideo}</p>`
            : html`
                ${cameras.length > 1 &&
                html`<div class="overlay-cameras" role="group" aria-label=${strings.dashcamRoutes.camera}>
                  ${cameras.map(
                    (name) =>
                      html`<button
                        key=${name}
                        class=${`btn ${name === camera ? "btn-primary" : ""}`}
                        aria-pressed=${name === camera}
                        onClick=${() => setCamera(name)}
                      >
                        ${CAMERA_LABELS[name] ?? name}
                      </button>`,
                  )}
                </div>`}
                <video
                  class="overlay-video"
                  ref=${videoRef}
                  src=${segmentUrl}
                  controls
                  autoplay
                  muted
                  playsinline
                  onEnded=${onEnded}
                ></video>
              `}

        <div class="overlay-actions">
          <button class="btn" onClick=${onClose}><${Icon} name="close" /> <span>${strings.common.close}</span></button>
          <a
            class="btn"
            href=${`/video/${encodeURIComponent(route.name)}/combined?camera=${encodeURIComponent(camera)}`}
            download=${downloadName(route, camera)}
          >
            <${Icon} name="download" /> <span>${strings.common.download}</span>
          </a>
          <button class="btn" onClick=${onClearName}><span>${strings.dashcamRoutes.clearName}</span></button>
          <button class="btn btn-danger" onClick=${onDelete}>
            <${Icon} name="trash" /> <span>${strings.common.delete}</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

export function DashcamRoutes() {
  const [routes, setRoutes] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [preservedOnly, setPreservedOnly] = useState(false);

  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  const reload = () => setReloadKey((key) => key + 1);

  // Mount/reload-only list stream. Per-route events render the grid progressively; the final "done"
  // record is not dropped because lib/sse.js flushes the tail (REWRITE_PLAN §3.4).
  useEffect(() => {
    setRoutes([]);
    setTotal(0);
    setFailed(false);
    setLoading(true);

    const stream = openStream("/api/routes", {
      onMessage: (event) => {
        if (event.event === "start") {
          setTotal(event.total);
        } else if (event.event === "route") {
          setRoutes((current) => [...current, event.route]);
        } else if (event.event === "done") {
          setLoading(false);
        }
      },
      onError: () => {
        setFailed(true);
        setLoading(false);
      },
    });

    // Abort the stream on unmount or reload so it never lingers after navigating away (§3.4, §15.6).
    return () => stream.close();
  }, [reloadKey]);

  // Overlay detail fetch, keyed on the open route. The mounted ref drops a late resolve so the cleanup
  // (which aborts the request) never sets state on a closed overlay (REWRITE_PLAN §3.4, §15.6).
  useEffect(() => {
    if (!selected) {
      return undefined;
    }

    let mounted = true;
    const controller = new AbortController();
    setDetail(null);
    setDetailFailed(false);

    http
      .get(`/api/routes/${encodeURIComponent(selected.name)}`, { signal: controller.signal })
      .then((data) => {
        if (mounted) {
          setDetail(data);
        }
      })
      .catch((error) => {
        if (mounted && error.name !== "AbortError") {
          setDetailFailed(true);
          showToast(messageFor(error, strings.dashcamRoutes.videoError), "error");
        }
      });

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [selected]);

  const patchRoute = (name, changes) =>
    setRoutes((current) => current.map((route) => (route.name === name ? { ...route, ...changes } : route)));

  const togglePreserve = async (route) => {
    const url = `/api/routes/${encodeURIComponent(route.name)}/preserve`;
    try {
      if (route.is_preserved) {
        await http.del(url);
      } else {
        await http.post(url);
      }

      patchRoute(route.name, { is_preserved: !route.is_preserved });
      showToast(route.is_preserved ? strings.dashcamRoutes.unpreserved : strings.dashcamRoutes.preserved);
    } catch (error) {
      showToast(messageFor(error, strings.dashcamRoutes.preserveFailed), "error");
    }
  };

  const startRename = () => {
    const date = selected.date;
    setRenameValue(date && !ISO_DATE.test(date) ? date : "");
    setRenaming(true);
  };

  const submitRename = async () => {
    const next = renameValue.trim();
    if (!next) {
      return;
    }

    try {
      const result = await http.post("/api/routes/rename", { name: selected.name, new: next });

      patchRoute(selected.name, { date: result.date });
      setSelected((current) => (current ? { ...current, date: result.date } : current));
      setRenaming(false);
      showToast(strings.dashcamRoutes.renamed);
    } catch (error) {
      showToast(messageFor(error, strings.dashcamRoutes.renameFailed), "error");
    }
  };

  const clearName = async () => {
    try {
      const result = await http.post("/api/routes/clear_name", { name: selected.name });

      patchRoute(selected.name, { date: result.date });
      setSelected((current) => (current ? { ...current, date: result.date } : current));
      showToast(strings.dashcamRoutes.renamed);
    } catch (error) {
      showToast(messageFor(error, strings.dashcamRoutes.clearNameFailed), "error");
    }
  };

  const remove = async (route) => {
    setPendingDelete(null);
    try {
      await http.del(`/api/routes/${encodeURIComponent(route.name)}`);

      setRoutes((current) => current.filter((entry) => entry.name !== route.name));
      if (selected?.name === route.name) {
        setSelected(null);
      }

      showToast(strings.dashcamRoutes.deleted);
    } catch (error) {
      showToast(messageFor(error, strings.dashcamRoutes.deleteFailed), "error");
    }
  };

  const removeAll = async () => {
    setConfirmDeleteAll(false);
    try {
      await http.del("/api/routes/delete_all");

      setRoutes([]);
      setSelected(null);
      showToast(strings.dashcamRoutes.deletedAll);
    } catch (error) {
      showToast(messageFor(error, strings.dashcamRoutes.deleteAllFailed), "error");
    }
  };

  const visible = preservedOnly ? routes.filter((route) => route.is_preserved) : routes;
  const status = renderStatus(failed, loading, routes.length, total, visible.length, preservedOnly);

  return html`
    <section class="routes">
      <header class="routes-header">
        <h1 class="routes-title">${strings.dashcamRoutes.title}</h1>
        <div class="routes-actions">
          ${routes.length > 0 &&
          html`<button
            class=${`btn ${preservedOnly ? "btn-primary" : ""}`}
            aria-pressed=${preservedOnly}
            onClick=${() => setPreservedOnly((value) => !value)}
          >
            <span>${preservedOnly ? strings.dashcamRoutes.showAll : strings.dashcamRoutes.showPreserved}</span>
          </button>`}
          ${routes.length > 0 &&
          html`<button class="btn btn-danger" onClick=${() => setConfirmDeleteAll(true)}>
            <${Icon} name="trash" /> <span>${strings.dashcamRoutes.deleteAll}</span>
          </button>`}
        </div>
      </header>

      ${status
        ? html`
            <p class="routes-message">${status}</p>
            ${failed &&
            html`<button class="btn btn-primary routes-retry" onClick=${reload}>${strings.dashcamRoutes.retry}</button>`}
          `
        : html`<div class="routes-grid">
            ${visible.map(
              (route) =>
                html`<${RouteCard}
                  key=${route.name}
                  route=${route}
                  onOpen=${() => setSelected(route)}
                  onTogglePreserve=${() => togglePreserve(route)}
                />`,
            )}
          </div>`}
      ${selected &&
      html`<${RouteOverlay}
        route=${selected}
        detail=${detail}
        failed=${detailFailed}
        onClose=${() => setSelected(null)}
        onRename=${startRename}
        onClearName=${clearName}
        onDelete=${() => setPendingDelete(selected)}
      />`}
      ${renaming &&
      html`<${Modal}
        title=${strings.dashcamRoutes.rename}
        message=${strings.dashcamRoutes.renamePlaceholder}
        confirmLabel=${strings.common.save}
        onConfirm=${submitRename}
        onCancel=${() => setRenaming(false)}
      >
        <input
          class="modal-field"
          value=${renameValue}
          onInput=${(event) => setRenameValue(event.target.value)}
          onKeyDown=${(event) => event.key === "Enter" && submitRename()}
          aria-label=${strings.dashcamRoutes.renamePlaceholder}
        />
      <//>`}
      ${pendingDelete &&
      html`<${Modal}
        title=${strings.dashcamRoutes.deleteConfirmTitle}
        message=${strings.dashcamRoutes.deleteConfirm(formatRouteDate(pendingDelete.date))}
        confirmLabel=${strings.common.delete}
        danger
        onConfirm=${() => remove(pendingDelete)}
        onCancel=${() => setPendingDelete(null)}
      />`}
      ${confirmDeleteAll &&
      html`<${Modal}
        title=${strings.dashcamRoutes.deleteAllConfirmTitle}
        message=${strings.dashcamRoutes.deleteAllConfirm}
        confirmLabel=${strings.dashcamRoutes.deleteAll}
        danger
        onConfirm=${removeAll}
        onCancel=${() => setConfirmDeleteAll(false)}
      />`}
    </section>
  `;
}

function renderStatus(failed, loading, count, total, visibleCount, preservedOnly) {
  if (failed) {
    return strings.dashcamRoutes.error;
  }

  if (loading && count === 0 && total === 0) {
    return strings.dashcamRoutes.loading;
  }

  if (loading && total > 0 && count < total) {
    return strings.dashcamRoutes.processing(count, total);
  }

  if (!loading && count === 0) {
    return strings.dashcamRoutes.empty;
  }

  if (preservedOnly && visibleCount === 0) {
    return strings.dashcamRoutes.preservedEmpty;
  }

  return null;
}
