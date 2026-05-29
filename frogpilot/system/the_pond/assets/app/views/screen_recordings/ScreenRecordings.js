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

function assetUrl(name, extension) {
  return `/screen_recordings/${encodeURIComponent(name)}${extension}`;
}

function displayName(recording) {
  return recording.is_custom_name ? recording.name.replace(/_/g, " ") : formatTimestamp(recording.created_at);
}

function RecordingCard({ recording, onOpen }) {
  const [armed, setArmed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const name = displayName(recording);

  return html`
    <button
      class="recording-card"
      onClick=${onOpen}
      onMouseEnter=${() => {
        setArmed(true);
        setHovering(true);
      }}
      onMouseLeave=${() => setHovering(false)}
    >
      <div class="recording-thumb">
        <img class="recording-img" src=${assetUrl(recording.name, ".png")} alt=${name} loading="lazy" />
        ${armed &&
        html`<img
          class=${`recording-img recording-gif ${hovering ? "is-visible" : ""}`}
          src=${assetUrl(recording.name, ".gif")}
          alt=""
          onError=${() => setArmed(false)}
        />`}
      </div>
      <span class="recording-name">${name}</span>
    </button>
  `;
}

function RecordingOverlay({ recording, onClose, onRename, onDelete }) {
  const videoRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Mount-only: keeping the <video> teardown out of the dependency list means a parent re-render
  // (recordings still streaming in behind the overlay) cannot re-run the cleanup and kill in-flight
  // playback. The latest onClose is read via a ref (REWRITE_PLAN §3.4, §12.3).
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

      // Stop playback and abort any in-flight range requests so a closed overlay leaves no <video>
      // streaming in the background.
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, []);

  return html`
    <div class="overlay" onClick=${onClose}>
      <div class="overlay-panel" onClick=${(event) => event.stopPropagation()}>
        <div class="overlay-head">
          <span class="overlay-title">${displayName(recording)}</span>
          <button class="icon-btn" aria-label=${strings.recordings.rename} onClick=${onRename}>
            <${Icon} name="edit" />
          </button>
        </div>
        <video
          class="overlay-video"
          ref=${videoRef}
          src=${assetUrl(recording.name, ".mp4")}
          controls
          autoplay
          muted
          playsinline
        ></video>
        <div class="overlay-actions">
          <button class="btn" onClick=${onClose}><${Icon} name="close" /> <span>${strings.common.close}</span></button>
          <a class="btn" href=${`/api/screen_recordings/download/${encodeURIComponent(recording.name)}`} download>
            <${Icon} name="download" /> <span>${strings.common.download}</span>
          </a>
          <button class="btn btn-danger" onClick=${onDelete}>
            <${Icon} name="trash" /> <span>${strings.common.delete}</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

export function ScreenRecordings() {
  const [recordings, setRecordings] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [selected, setSelected] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const reload = () => setReloadKey((key) => key + 1);

  useEffect(() => {
    setRecordings([]);
    setTotal(0);
    setFailed(false);
    setLoading(true);

    const stream = openStream("/api/screen_recordings/list", {
      onMessage: (event) => {
        if (event.event === "start") {
          setTotal(event.total);
        } else if (event.event === "recording") {
          setRecordings((current) => [...current, event.recording]);
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

  const remove = async (recording) => {
    setPendingDelete(null);
    try {
      await http.del(`/api/screen_recordings/delete/${encodeURIComponent(recording.name)}`);
      if (selected?.name === recording.name) {
        setSelected(null);
      }

      showToast(strings.recordings.deleted);
      reload();
    } catch (error) {
      showToast(messageFor(error), "error");
    }
  };

  const removeAll = async () => {
    setConfirmDeleteAll(false);
    try {
      await http.del("/api/screen_recordings/delete_all");

      setSelected(null);
      showToast(strings.recordings.deletedAll);
      reload();
    } catch (error) {
      showToast(messageFor(error), "error");
    }
  };

  const startRename = (recording) => {
    setRenameValue(recording.is_custom_name ? recording.name : "");
    setRenaming(recording);
  };

  const submitRename = async () => {
    const next = renameValue.trim();
    if (!next) {
      return;
    }

    try {
      await http.post("/api/screen_recordings/rename", { old: renaming.name, new: next });

      setSelected(null);
      setRenaming(null);
      showToast(strings.recordings.renamed);
      reload();
    } catch (error) {
      showToast(messageFor(error) || strings.recordings.renameFailed, "error");
    }
  };

  const status = renderStatus(failed, loading, recordings.length, total);

  return html`
    <section class="recordings">
      <header class="recordings-header">
        <h1 class="recordings-title">${strings.recordings.title}</h1>
        ${recordings.length > 0 &&
        html`<button class="btn btn-danger" onClick=${() => setConfirmDeleteAll(true)}>
          <${Icon} name="trash" /> <span>${strings.recordings.deleteAll}</span>
        </button>`}
      </header>

      ${status && html`<p class="recordings-message">${status}</p>`}

      <div class="recordings-grid">
        ${recordings.map(
          (recording) =>
            html`<${RecordingCard} key=${recording.name} recording=${recording} onOpen=${() => setSelected(recording)} />`,
        )}
      </div>

      ${selected &&
      html`<${RecordingOverlay}
        recording=${selected}
        onClose=${() => setSelected(null)}
        onRename=${() => startRename(selected)}
        onDelete=${() => setPendingDelete(selected)}
      />`}
      ${pendingDelete &&
      html`<${Modal}
        title=${strings.recordings.deleteConfirmTitle}
        message=${strings.recordings.deleteConfirm(displayName(pendingDelete))}
        confirmLabel=${strings.common.delete}
        danger
        onConfirm=${() => remove(pendingDelete)}
        onCancel=${() => setPendingDelete(null)}
      />`}
      ${confirmDeleteAll &&
      html`<${Modal}
        title=${strings.recordings.deleteAllConfirmTitle}
        message=${strings.recordings.deleteAllConfirm}
        confirmLabel=${strings.recordings.deleteAll}
        danger
        onConfirm=${removeAll}
        onCancel=${() => setConfirmDeleteAll(false)}
      />`}
      ${renaming &&
      html`<${Modal}
        title=${strings.recordings.renameTitle}
        message=${strings.recordings.renameLabel}
        confirmLabel=${strings.common.save}
        onConfirm=${submitRename}
        onCancel=${() => setRenaming(null)}
      >
        <input
          class="modal-field"
          value=${renameValue}
          onInput=${(event) => setRenameValue(event.target.value)}
          onKeyDown=${(event) => event.key === "Enter" && submitRename()}
          aria-label=${strings.recordings.renameLabel}
        />
      <//>`}
    </section>
  `;
}

function renderStatus(failed, loading, count, total) {
  if (failed) {
    return strings.recordings.error;
  }

  if (loading && count === 0 && total === 0) {
    return strings.recordings.loading;
  }

  if (loading && total > 0 && count < total) {
    return strings.recordings.processing(count, total);
  }

  if (!loading && count === 0) {
    return strings.recordings.empty;
  }

  return null;
}
