import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { CSRF_HEADERS, HttpError, errorMessage, http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

// The 7 color keys the runtime parser reads from colors.json; the picker writes exactly these so an
// unknown value can never reach the renderer (mirrors themes_service.COLOR_KEYS). Keys are alphabetized;
// the labels map each to its human-facing name.
const COLOR_LABELS = {
  LaneLines: "Lane Lines",
  LeadMarker: "Lead Marker",
  Path: "Path",
  PathEdge: "Path Edge",
  Sidebar1: "Sidebar Top",
  Sidebar2: "Sidebar Middle",
  Sidebar3: "Sidebar Bottom",
};

// FrogPilot's brand green, the same default the on-device editor seeds (theme_maker.js defaultColors).
const DEFAULT_COLORS = {
  LaneLines: { red: 23, green: 134, blue: 68, alpha: 255 },
  LeadMarker: { red: 23, green: 134, blue: 68, alpha: 255 },
  Path: { red: 23, green: 134, blue: 68, alpha: 255 },
  PathEdge: { red: 18, green: 107, blue: 54, alpha: 255 },
  Sidebar1: { red: 23, green: 134, blue: 68, alpha: 255 },
  Sidebar2: { red: 23, green: 134, blue: 68, alpha: 255 },
  Sidebar3: { red: 23, green: 134, blue: 68, alpha: 255 },
};

const DISTANCE_ICON_KEYS = ["aggressive", "relaxed", "standard", "traffic"];
const DISTANCE_ICON_LABELS = {
  aggressive: "Aggressive",
  relaxed: "Relaxed",
  standard: "Standard",
  traffic: "Traffic",
};

const ICON_LABELS = {
  homeButton: "Home Button",
  settingsButton: "Settings Button",
};

// Sound field names match the backend form keys (themes_service.SOUND_NAMES); labels are display-only.
const SOUND_KEYS = ["disengage", "engage", "prompt", "startup"];
const SOUND_LABELS = {
  disengage: "Disengage",
  engage: "Engage",
  prompt: "Prompt",
  startup: "Startup",
};

// The saveChecklist vocabulary the backend mirrors exactly (B5 contract). Each component the user can
// include in an Apply/Save/Submit; the order here drives the confirmation checklist rows.
const COMPONENTS = ["colors", "distance_icons", "icons", "sounds", "steering_wheel", "turn_signals"];
const COMPONENT_LABELS = {
  colors: strings.themeMaker.colorsTitle,
  distance_icons: strings.themeMaker.distanceIconsTitle,
  icons: strings.themeMaker.iconsTitle,
  sounds: strings.themeMaker.soundsTitle,
  steering_wheel: strings.themeMaker.steeringWheelTitle,
  turn_signals: strings.themeMaker.turnSignalsTitle,
};

// The Manage modal lists one component per tab; "colors" maps to the has_colors summary flag, etc.
const MANAGE_TABS = COMPONENTS;
const SUMMARY_FLAGS = {
  colors: "has_colors",
  distance_icons: "has_distance_icons",
  icons: "has_icons",
  sounds: "has_sounds",
  steering_wheel: "has_steering_wheel",
  turn_signals: "has_turn_signals",
};

const TURN_SIGNAL_STYLES = ["Static", "Traditional"];
const TURN_SIGNAL_LENGTH_MIN = 25;
const TURN_SIGNAL_LENGTH_MAX = 1000;

function emptyState() {
  // ONE state model (not the old dual fileStore/state): every asset is a File kept on `files`, every
  // display name on `names`, and the form is rebuilt from these on each action.
  return {
    colors: { ...DEFAULT_COLORS },
    files: { distanceIcons: {}, sounds: {} },
    names: { distanceIcons: {}, sounds: {} },
    sequential: [],
    themeName: "",
    discordUsername: "",
    turnSignalLength: 100,
    turnSignalStyle: "Static",
    turnSignalType: "Single Image",
  };
}

function hexFromColor(color) {
  const channel = (value) =>
    Number(value || 0)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`;
}

function colorFromHex(hex) {
  return {
    red: parseInt(hex.slice(1, 3), 16),
    green: parseInt(hex.slice(3, 5), 16),
    blue: parseInt(hex.slice(5, 7), 16),
    alpha: 255,
  };
}

function clampLength(raw) {
  const value = parseInt(raw, 10);
  if (Number.isNaN(value)) {
    return TURN_SIGNAL_LENGTH_MIN;
  }

  return Math.max(TURN_SIGNAL_LENGTH_MIN, Math.min(TURN_SIGNAL_LENGTH_MAX, value));
}

// Reject the upload client-side for the same reasons the backend would (oversize, wrong MIME, GIF for a
// sequential frame), so the user gets an immediate toast instead of a round-trip 400.
function rejectionFor(file, kind, sequential) {
  if (sequential && file.type === "image/gif") {
    return strings.themeMaker.sequentialNoGif;
  }
  if (file.size > MAX_FILE_BYTES) {
    return strings.themeMaker.uploadTooLarge(file.name);
  }
  if (!file.type.startsWith(`${kind}/`)) {
    return strings.themeMaker.wrongType(kind);
  }

  return null;
}

function FileField({ label, accept, name, multiple = false, onPick, onClear }) {
  const inputRef = useRef(null);

  return html`
    <div class="tm-file">
      <span class="tm-file-label">${label}</span>
      <div class="tm-file-row">
        <button class="btn tm-file-choose" onClick=${() => inputRef.current?.click()}>${strings.themeMaker.chooseFile}</button>
        <span class="tm-file-name">${name || strings.themeMaker.noFile}</span>
        ${name &&
        html`<button class="icon-btn tm-file-clear" aria-label=${strings.themeMaker.clearFile} onClick=${onClear}>
          <${Icon} name="close" />
        </button>`}
      </div>
      <input
        ref=${inputRef}
        class="tm-file-input"
        type="file"
        accept=${accept}
        multiple=${multiple}
        onChange=${(event) => {
          onPick(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  `;
}

function Checklist({ title, available, checklist, onToggle }) {
  return html`
    <fieldset class="tm-checklist">
      <legend class="tm-checklist-title">${title}</legend>
      ${COMPONENTS.filter((component) => available[component]).map(
        (component) => html`
          <label class="tm-checklist-item" key=${component}>
            <input type="checkbox" checked=${checklist[component]} onChange=${() => onToggle(component)} />
            <span>${COMPONENT_LABELS[component]}</span>
          </label>
        `,
      )}
    </fieldset>
  `;
}

export function ThemeMaker() {
  const [model, setModel] = useState(emptyState);
  const [checklist, setChecklist] = useState({});
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  const [themes, setThemes] = useState([]);
  const [activeTab, setActiveTab] = useState("colors");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [showManage, setShowManage] = useState(false);
  const [showSequence, setShowSequence] = useState(false);

  // Every in-flight fetch is registered here so the mount-only cleanup can abort them all; an aborted
  // request on unmount is expected teardown, not an error (REWRITE_PLAN §3.4).
  const controllersRef = useRef(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of controllersRef.current) {
        controller.abort();
      }
      controllersRef.current.clear();
    };
  }, []);

  const track = () => {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return controller;
  };
  const release = (controller) => controllersRef.current.delete(controller);

  // What is available to include in a confirmation checklist: colors are always present (defaults are
  // valid), every other component only when the user has provided at least one file or loaded one.
  const available = {
    colors: true,
    distance_icons: DISTANCE_ICON_KEYS.some((key) => model.names.distanceIcons[key]),
    icons: Object.keys(ICON_LABELS).some((key) => model.names[key]),
    sounds: SOUND_KEYS.some((key) => model.names.sounds[key]),
    steering_wheel: Boolean(model.names.steeringWheel),
    turn_signals: Boolean(model.names.turnSignal || model.names.turnSignalBlindspot || model.sequential.length),
  };

  const setColor = (key, hex) => {
    setModel((current) => ({ ...current, colors: { ...current.colors, [key]: colorFromHex(hex) } }));
  };

  const pickSingle = (kind, key, fileList) => {
    const file = fileList[0];
    if (!file) {
      return;
    }

    const rejection = rejectionFor(file, kind, false);
    if (rejection) {
      showToast(rejection, "error");
      return;
    }

    setModel((current) => ({
      ...current,
      files: { ...current.files, [key]: file },
      names: { ...current.names, [key]: file.name },
    }));
  };

  const pickDistance = (key, fileList) => {
    const file = fileList[0];
    if (!file) {
      return;
    }

    const rejection = rejectionFor(file, "image", false);
    if (rejection) {
      showToast(rejection, "error");
      return;
    }

    setModel((current) => ({
      ...current,
      files: { ...current.files, distanceIcons: { ...current.files.distanceIcons, [key]: file } },
      names: { ...current.names, distanceIcons: { ...current.names.distanceIcons, [key]: file.name } },
    }));
  };

  const pickSound = (key, fileList) => {
    const file = fileList[0];
    if (!file) {
      return;
    }

    const rejection = rejectionFor(file, "audio", false);
    if (rejection) {
      showToast(rejection, "error");
      return;
    }

    setModel((current) => ({
      ...current,
      files: { ...current.files, sounds: { ...current.files.sounds, [key]: file } },
      names: { ...current.names, sounds: { ...current.names.sounds, [key]: file.name } },
    }));
  };

  const pickSequential = (fileList) => {
    const incoming = Array.from(fileList);
    for (const file of incoming) {
      const rejection = rejectionFor(file, "image", true);
      if (rejection) {
        showToast(rejection, "error");
        return;
      }
    }

    setModel((current) => ({ ...current, sequential: [...current.sequential, ...incoming] }));
  };

  const clearKey = (key) => {
    setModel((current) => {
      const files = { ...current.files };
      delete files[key];
      const names = { ...current.names };
      delete names[key];
      return { ...current, files, names };
    });
  };

  const clearDistance = (key) => {
    setModel((current) => {
      const distanceFiles = { ...current.files.distanceIcons };
      delete distanceFiles[key];
      const distanceNames = { ...current.names.distanceIcons };
      delete distanceNames[key];
      return {
        ...current,
        files: { ...current.files, distanceIcons: distanceFiles },
        names: { ...current.names, distanceIcons: distanceNames },
      };
    });
  };

  const clearSound = (key) => {
    setModel((current) => {
      const soundFiles = { ...current.files.sounds };
      delete soundFiles[key];
      const soundNames = { ...current.names.sounds };
      delete soundNames[key];
      return {
        ...current,
        files: { ...current.files, sounds: soundFiles },
        names: { ...current.names, sounds: soundNames },
      };
    });
  };

  const clearSequential = () => setModel((current) => ({ ...current, sequential: [] }));

  const setTurnSignalType = (type) => {
    // Switching type discards any previously chosen turn-signal frames so a sequential pick never leaks
    // into a single-image submit (mirrors the old toggleTurnSignalType reset).
    setModel((current) => {
      const files = { ...current.files };
      delete files.turnSignal;
      const names = { ...current.names };
      delete names.turnSignal;
      return { ...current, turnSignalType: type, sequential: [], files, names };
    });
  };

  const buildForm = (includeName) => {
    const form = new FormData();
    if (includeName) {
      form.append("themeName", model.themeName.trim());
    }
    if (model.discordUsername.trim()) {
      form.append("discordUsername", model.discordUsername.trim());
    }
    form.append("saveChecklist", JSON.stringify(checklist));

    if (checklist.colors) {
      form.append("colors", JSON.stringify(model.colors));
    }
    if (checklist.icons) {
      for (const key of Object.keys(ICON_LABELS)) {
        if (model.files[key]) {
          form.append(key, model.files[key]);
        }
      }
    }
    if (checklist.distance_icons) {
      for (const key of DISTANCE_ICON_KEYS) {
        if (model.files.distanceIcons[key]) {
          form.append(`distanceIcons_${key}`, model.files.distanceIcons[key]);
        }
      }
    }
    if (checklist.sounds) {
      for (const key of SOUND_KEYS) {
        if (model.files.sounds[key]) {
          form.append(key, model.files.sounds[key]);
        }
      }
    }
    if (checklist.steering_wheel && model.files.steeringWheel) {
      form.append("steeringWheel", model.files.steeringWheel);
    }
    if (checklist.turn_signals) {
      appendTurnSignals(form);
    }

    return form;
  };

  const appendTurnSignals = (form) => {
    form.append("turnSignalStyle", model.turnSignalStyle);
    form.append("turnSignalType", model.turnSignalType);
    form.append("turnSignalLength", String(model.turnSignalLength));

    if (model.files.turnSignalBlindspot) {
      form.append("turnSignalBlindspot", model.files.turnSignalBlindspot);
    }
    if (model.turnSignalType === "Sequential") {
      model.sequential.forEach((file, index) => form.append(`turn_signal_${index + 1}`, file));
    } else if (model.files.turnSignal) {
      form.append("turnSignal", model.files.turnSignal);
    }
  };

  const openConfirm = (kind) => {
    // Re-arm an empty checklist each time the dialog opens so a prior selection cannot silently carry over.
    // Colors are always available (the defaults are valid), so the dialog always has at least one row.
    setChecklist(Object.fromEntries(COMPONENTS.map((component) => [component, false])));
    setDialog(kind);
  };

  const toggleChecklist = (component) => {
    setChecklist((current) => ({ ...current, [component]: !current[component] }));
  };

  const submitAction = async (kind) => {
    if (!Object.values(checklist).some(Boolean)) {
      showToast(strings.themeMaker.selectComponent, "error");
      return;
    }
    if (kind !== "apply" && !model.themeName.trim()) {
      showToast(strings.themeMaker.nameRequired, "error");
      return;
    }
    if (kind === "submit" && !model.discordUsername.trim()) {
      showToast(strings.themeMaker.submitDiscordRequired, "error");
      return;
    }

    const endpoints = { apply: "/api/themes/apply", save: "/api/themes", submit: "/api/themes/submit" };
    const successes = { apply: strings.themeMaker.applied, save: strings.themeMaker.saved, submit: strings.themeMaker.submitted };
    const failures = {
      apply: strings.themeMaker.applyError,
      save: strings.themeMaker.saveError,
      submit: strings.themeMaker.submitError,
    };

    setDialog(null);
    setBusy(true);
    const controller = track();
    try {
      await http.post(endpoints[kind], buildForm(kind !== "apply"), { signal: controller.signal });
      if (!mountedRef.current) {
        return;
      }

      showToast(successes[kind]);
      if (kind !== "apply") {
        setModel((current) => ({ ...current, themeName: "" }));
      }
    } catch (error) {
      if (mountedRef.current && error.name !== "AbortError") {
        showToast(messageFor(error, failures[kind]), "error");
      }
    } finally {
      release(controller);
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const downloadTheme = async () => {
    if (!Object.values(checklist).some(Boolean)) {
      showToast(strings.themeMaker.selectComponent, "error");
      return;
    }

    setDialog(null);
    setBusy(true);
    const controller = track();
    try {
      // The download response is a zip attachment, so fetch the bytes and hand them to a transient anchor
      // rather than routing through lib/http (which parses JSON). The object URL is revoked immediately.
      const response = await fetch("/api/themes/download", {
        method: "POST",
        headers: CSRF_HEADERS,
        body: buildForm(false),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new HttpError(await errorMessage(response), response.status);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${model.themeName.trim() || "theme"}.zip`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      if (mountedRef.current && error.name !== "AbortError") {
        showToast(messageFor(error, strings.themeMaker.downloadError), "error");
      }
    } finally {
      release(controller);
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const openManage = async () => {
    setActiveTab("colors");
    setShowManage(true);
    await refreshThemes();
  };

  const refreshThemes = async () => {
    const controller = track();
    try {
      const data = await http.get("/api/themes/list", { signal: controller.signal });
      if (mountedRef.current) {
        setThemes([...data.themes].sort((first, second) => first.name.localeCompare(second.name, undefined, { numeric: true })));
      }
    } catch (error) {
      if (mountedRef.current && error.name !== "AbortError") {
        showToast(messageFor(error, strings.themeMaker.manageError), "error");
      }
    } finally {
      release(controller);
    }
  };

  const loadAsset = async (theme) => {
    const controller = track();
    try {
      const data = await http.get(`/api/themes/load/${theme.path}?type=${theme.type}`, { signal: controller.signal });

      // Pull the component's bytes back into File objects so a subsequent Save/Apply re-submits them (the
      // backend assembles a theme from request.files, never from a stored copy). Mirrors the old
      // loadThemeAsset round-trip; colors are JSON only and need no fetch.
      const patch = await loadAssetFiles(theme, data, controller.signal);
      if (!mountedRef.current) {
        return;
      }

      setModel((current) => mergeLoadedAsset(current, theme, data, patch));
      showToast(strings.themeMaker.loaded(COMPONENT_LABELS[activeTab], theme.name));
      setShowManage(false);
    } catch (error) {
      if (mountedRef.current && error.name !== "AbortError") {
        showToast(messageFor(error, strings.themeMaker.loadError), "error");
      }
    } finally {
      release(controller);
    }
  };

  const fetchAsset = async (theme, relativePath, signal) => {
    const response = await fetch(`/api/themes/asset/${theme.path}/${relativePath}?type=${theme.type}`, { signal });
    if (!response.ok) {
      throw new HttpError(await errorMessage(response), response.status);
    }

    const blob = await response.blob();
    return new File([blob], relativePath.split("/").pop(), { type: blob.type });
  };

  const loadAssetFiles = async (theme, data, signal) => {
    const patch = { files: {}, distanceIcons: {}, sounds: {} };

    if (activeTab === "icons") {
      for (const key of Object.keys(ICON_LABELS)) {
        if (data.images?.[key]) {
          patch.files[key] = await fetchAsset(theme, data.images[key].path, signal);
        }
      }
    } else if (activeTab === "distance_icons" && data.images?.distanceIcons) {
      for (const [key, asset] of Object.entries(data.images.distanceIcons)) {
        patch.distanceIcons[key] = await fetchAsset(theme, asset.path, signal);
      }
    } else if (activeTab === "sounds" && data.sounds) {
      for (const [key, asset] of Object.entries(data.sounds)) {
        patch.sounds[key] = await fetchAsset(theme, asset.path, signal);
      }
    } else if (activeTab === "steering_wheel" && data.images?.steeringWheel) {
      patch.files.steeringWheel = await fetchAsset(theme, data.images.steeringWheel.path, signal);
    } else if (activeTab === "turn_signals") {
      if (data.images?.turnSignal) {
        patch.files.turnSignal = await fetchAsset(theme, data.images.turnSignal.path, signal);
      }
      if (data.images?.turnSignalBlindspot) {
        patch.files.turnSignalBlindspot = await fetchAsset(theme, data.images.turnSignalBlindspot.path, signal);
      }
    }

    return patch;
  };

  const mergeLoadedAsset = (current, theme, data, patch) => {
    const next = {
      ...current,
      files: { ...current.files, ...patch.files },
      names: { ...current.names },
    };

    if (activeTab === "colors" && data.colors) {
      next.colors = { ...DEFAULT_COLORS, ...data.colors };
    }
    if (activeTab === "icons") {
      for (const key of Object.keys(ICON_LABELS)) {
        if (data.images?.[key]) {
          next.names[key] = theme.name;
        }
      }
    }
    if (activeTab === "distance_icons" && data.images?.distanceIcons) {
      next.files.distanceIcons = { ...current.files.distanceIcons, ...patch.distanceIcons };
      next.names.distanceIcons = { ...current.names.distanceIcons };
      for (const key of Object.keys(data.images.distanceIcons)) {
        next.names.distanceIcons[key] = theme.name;
      }
    }
    if (activeTab === "sounds" && data.sounds) {
      next.files.sounds = { ...current.files.sounds, ...patch.sounds };
      next.names.sounds = { ...current.names.sounds };
      for (const key of Object.keys(data.sounds)) {
        next.names.sounds[key] = theme.name;
      }
    }
    if (activeTab === "steering_wheel" && data.images?.steeringWheel) {
      next.names.steeringWheel = theme.name;
    }
    if (activeTab === "turn_signals") {
      mergeTurnSignalLoad(next, data, theme.name);
    }

    return next;
  };

  const mergeTurnSignalLoad = (next, data, themeName) => {
    if (data.turnSignalStyle) {
      next.turnSignalStyle = data.turnSignalStyle;
    }
    if (data.turnSignalType) {
      next.turnSignalType = data.turnSignalType;
    }
    if (data.turnSignalLength) {
      next.turnSignalLength = data.turnSignalLength;
    }
    if (data.images?.turnSignal) {
      next.names.turnSignal = themeName;
    }
    if (data.images?.turnSignalBlindspot) {
      next.names.turnSignalBlindspot = themeName;
    }
    // Sequential frame loading is not re-fetched into editable frames (the editor re-orders only freshly
    // uploaded sequences); a single-image load covers the common round-trip.
    next.sequential = [];
  };

  const downloadAsset = async (theme) => {
    const controller = track();
    try {
      await http.post("/api/themes/download_asset", { component: activeTab, name: theme.name }, { signal: controller.signal });
      if (!mountedRef.current) {
        return;
      }

      // The backend dispatches the download on a worker thread and exposes no progress route, so this is
      // fire-and-forget: toast that it started, then refresh the list so a freshly downloaded asset shows.
      showToast(strings.themeMaker.downloadStarted(COMPONENT_LABELS[activeTab], theme.name));
      await refreshThemes();
    } catch (error) {
      if (mountedRef.current && error.name !== "AbortError") {
        showToast(messageFor(error, strings.themeMaker.downloadAssetError), "error");
      }
    } finally {
      release(controller);
    }
  };

  const removeTheme = async (theme) => {
    setPendingDelete(null);
    const controller = track();
    try {
      const component =
        activeTab === "steering_wheel" ? "" : `&component=${activeTab === "turn_signals" ? "signals" : activeTab}`;
      await http.del(`/api/themes/delete/${theme.path}?type=${theme.type}${component}`, { signal: controller.signal });
      if (!mountedRef.current) {
        return;
      }

      showToast(strings.themeMaker.deleted);
      await refreshThemes();
    } catch (error) {
      if (mountedRef.current && error.name !== "AbortError") {
        showToast(messageFor(error, strings.themeMaker.deleteError), "error");
      }
    } finally {
      release(controller);
    }
  };

  const visibleThemes = themes.filter((theme) => {
    if (activeTab === "steering_wheel") {
      return theme.type === "steering_wheel" || theme[SUMMARY_FLAGS.steering_wheel];
    }

    return theme[SUMMARY_FLAGS[activeTab]];
  });

  return html`
    <section class="theme-maker">
      <header class="theme-maker-header">
        <h1 class="theme-maker-title">${strings.themeMaker.title}</h1>
      </header>

      <div class="tm-sections">
        ${ColorsSection({ colors: model.colors, onChange: setColor })}
        ${DistanceSection({ model, onPick: pickDistance, onClear: clearDistance })}
        ${IconsSection({ model, onPick: pickSingle, onClear: clearKey })}
        ${SoundsSection({ model, onPick: pickSound, onClear: clearSound })}
        ${SteeringSection({ model, onPick: pickSingle, onClear: clearKey })}
        ${TurnSignalsSection({
          model,
          onLength: (value) => setModel((current) => ({ ...current, turnSignalLength: value })),
          onStyle: (style) => setModel((current) => ({ ...current, turnSignalStyle: style })),
          onType: setTurnSignalType,
          onPickMain: (fileList) =>
            model.turnSignalType === "Sequential" ? pickSequential(fileList) : pickSingle("image", "turnSignal", fileList),
          onPickBlindspot: (fileList) => pickSingle("image", "turnSignalBlindspot", fileList),
          onClearMain: () => (model.turnSignalType === "Sequential" ? clearSequential() : clearKey("turnSignal")),
          onClearBlindspot: () => clearKey("turnSignalBlindspot"),
          onSequence: () => setShowSequence(true),
        })}
      </div>

      <div class="theme-maker-actions">
        <button class="btn btn-primary tm-apply" disabled=${busy} onClick=${() => openConfirm("apply")}>
          ${strings.themeMaker.applyButton}
        </button>
        <button class="btn tm-manage" onClick=${openManage}>
          <${Icon} name="palette" /> <span>${strings.themeMaker.manageButton}</span>
        </button>
        <button class="btn tm-save" disabled=${busy} onClick=${() => openConfirm("save")}>
          ${strings.themeMaker.saveButton}
        </button>
        <button class="btn tm-submit" disabled=${busy} onClick=${() => openConfirm("submit")}>
          ${strings.themeMaker.submitButton}
        </button>
        <button class="btn tm-download" disabled=${busy} onClick=${() => openConfirm("download")}>
          <${Icon} name="download" /> <span>${strings.themeMaker.downloadButton}</span>
        </button>
      </div>

      ${dialog &&
      html`<${Modal}
        title=${strings.themeMaker[`${dialog}Button`]}
        confirmLabel=${strings.themeMaker[`${dialog}Button`]}
        onConfirm=${() => (dialog === "download" ? downloadTheme() : submitAction(dialog))}
        onCancel=${() => setDialog(null)}
      >
        ${(dialog === "save" || dialog === "submit") &&
        html`<label class="tm-name-field">
          <span>${strings.themeMaker.nameLabel}</span>
          <input
            class="modal-field"
            value=${model.themeName}
            placeholder=${strings.themeMaker.namePlaceholder}
            onInput=${(event) => setModel((current) => ({ ...current, themeName: event.target.value }))}
          />
        </label>`}
        ${dialog === "submit" &&
        html`<label class="tm-name-field">
          <span>${strings.themeMaker.submitDiscordLabel}</span>
          <input
            class="modal-field"
            value=${model.discordUsername}
            onInput=${(event) => setModel((current) => ({ ...current, discordUsername: event.target.value }))}
          />
        </label>`}
        <${Checklist}
          title=${strings.themeMaker.selectComponentsTitle}
          available=${available}
          checklist=${checklist}
          onToggle=${toggleChecklist}
        />
      <//>`}
      ${showManage &&
      html`<${Modal}
        title=${strings.themeMaker.manageTitle}
        cancelLabel=${strings.common.close}
        onCancel=${() => setShowManage(false)}
        onConfirm=${() => setShowManage(false)}
        confirmLabel=${strings.common.close}
      >
        <div class="tm-tabs" role="tablist">
          ${MANAGE_TABS.map(
            (tab) =>
              html`<button
                key=${tab}
                role="tab"
                aria-selected=${tab === activeTab}
                class=${`btn tm-tab ${tab === activeTab ? "is-active" : ""}`}
                onClick=${() => setActiveTab(tab)}
              >
                ${COMPONENT_LABELS[tab]}
              </button>`,
          )}
        </div>
        <ul class="tm-theme-list">
          ${visibleThemes.length === 0 && html`<li class="tm-theme-empty">${strings.themeMaker.manageEmpty}</li>`}
          ${visibleThemes.map(
            (theme) =>
              html`<li class="tm-theme-row" key=${`${theme.type}:${theme.path}`}>
                <button class="tm-theme-load" onClick=${() => loadAsset(theme)}>
                  <span class="tm-theme-name">${theme.name}</span>
                  ${theme.is_user_created && html`<span class="tm-theme-badge">${strings.themeMaker.userBadge}</span>`}
                </button>
                ${theme.type === "holiday"
                  ? html`<span class="tm-theme-readonly">${strings.themeMaker.holidayBadge}</span>`
                  : theme.is_user_created
                    ? html`<button
                        class="icon-btn tm-theme-delete"
                        aria-label=${strings.themeMaker.deleteAsset}
                        onClick=${() => setPendingDelete(theme)}
                      >
                        <${Icon} name="trash" />
                      </button>`
                    : html`<button
                        class="icon-btn tm-theme-download"
                        aria-label=${strings.themeMaker.downloadAsset}
                        onClick=${() => downloadAsset(theme)}
                      >
                        <${Icon} name="download" />
                      </button>`}
              </li>`,
          )}
        </ul>
      <//>`}
      ${pendingDelete &&
      html`<${Modal}
        title=${strings.themeMaker.deleteTitle}
        message=${strings.themeMaker.deleteConfirm(pendingDelete.name)}
        confirmLabel=${strings.common.delete}
        danger
        onConfirm=${() => removeTheme(pendingDelete)}
        onCancel=${() => setPendingDelete(null)}
      />`}
      ${showSequence &&
      html`<${SequenceModal}
        files=${model.sequential}
        onReorder=${(next) => setModel((current) => ({ ...current, sequential: next }))}
        onClose=${() => setShowSequence(false)}
      />`}
    </section>
  `;
}

function ColorsSection({ colors, onChange }) {
  return html`
    <section class="tm-section">
      <h2 class="tm-section-title">${strings.themeMaker.colorsTitle}</h2>
      <div class="tm-colors">
        ${Object.keys(COLOR_LABELS).map(
          (key) =>
            html`<label class="tm-color" key=${key}>
              <span>${COLOR_LABELS[key]}</span>
              <input type="color" value=${hexFromColor(colors[key])} onInput=${(event) => onChange(key, event.target.value)} />
            </label>`,
        )}
      </div>
    </section>
  `;
}

function DistanceSection({ model, onPick, onClear }) {
  return html`
    <section class="tm-section">
      <h2 class="tm-section-title">${strings.themeMaker.distanceIconsTitle}</h2>
      <div class="tm-uploads">
        ${DISTANCE_ICON_KEYS.map(
          (key) =>
            html`<${FileField}
              key=${key}
              label=${DISTANCE_ICON_LABELS[key]}
              accept="image/*"
              name=${model.names.distanceIcons[key] || ""}
              onPick=${(fileList) => onPick(key, fileList)}
              onClear=${() => onClear(key)}
            />`,
        )}
      </div>
      <p class="tm-hint">${strings.themeMaker.distanceIconsHint}</p>
    </section>
  `;
}

function IconsSection({ model, onPick, onClear }) {
  return html`
    <section class="tm-section">
      <h2 class="tm-section-title">${strings.themeMaker.iconsTitle}</h2>
      <div class="tm-uploads">
        ${Object.keys(ICON_LABELS).map(
          (key) =>
            html`<${FileField}
              key=${key}
              label=${ICON_LABELS[key]}
              accept="image/*"
              name=${model.names[key] || ""}
              onPick=${(fileList) => onPick("image", key, fileList)}
              onClear=${() => onClear(key)}
            />`,
        )}
      </div>
      <p class="tm-hint">${strings.themeMaker.iconsHint}</p>
    </section>
  `;
}

function SoundsSection({ model, onPick, onClear }) {
  return html`
    <section class="tm-section">
      <h2 class="tm-section-title">${strings.themeMaker.soundsTitle}</h2>
      <div class="tm-uploads">
        ${SOUND_KEYS.map(
          (key) =>
            html`<${FileField}
              key=${key}
              label=${SOUND_LABELS[key]}
              accept="audio/*"
              name=${model.names.sounds[key] || ""}
              onPick=${(fileList) => onPick(key, fileList)}
              onClear=${() => onClear(key)}
            />`,
        )}
      </div>
    </section>
  `;
}

function SteeringSection({ model, onPick, onClear }) {
  return html`
    <section class="tm-section">
      <h2 class="tm-section-title">${strings.themeMaker.steeringWheelTitle}</h2>
      <div class="tm-uploads">
        <${FileField}
          label=${strings.themeMaker.steeringWheelTitle}
          accept="image/*"
          name=${model.names.steeringWheel || ""}
          onPick=${(fileList) => onPick("image", "steeringWheel", fileList)}
          onClear=${() => onClear("steeringWheel")}
        />
      </div>
      <p class="tm-hint">${strings.themeMaker.steeringWheelHint}</p>
    </section>
  `;
}

function TurnSignalsSection({
  model,
  onLength,
  onStyle,
  onType,
  onPickMain,
  onPickBlindspot,
  onClearMain,
  onClearBlindspot,
  onSequence,
}) {
  const sequential = model.turnSignalType === "Sequential";
  const mainName = sequential
    ? model.sequential.length
      ? strings.themeMaker.framesSelected(model.sequential.length)
      : model.names.turnSignal || ""
    : model.names.turnSignal || "";

  return html`
    <section class="tm-section">
      <h2 class="tm-section-title">${strings.themeMaker.turnSignalsTitle}</h2>
      <div class="tm-turn-signals">
        <label class="tm-length-field">
          <span>${strings.themeMaker.turnSignalLengthLabel}</span>
          <input
            class="tm-length-input"
            type="text"
            inputmode="numeric"
            value=${model.turnSignalLength}
            onInput=${(event) => onLength(event.target.value)}
            onBlur=${(event) => onLength(clampLength(event.target.value))}
          />
        </label>

        <div class="tm-toggle-group">
          <span class="tm-toggle-label">${strings.themeMaker.turnSignalStyleLabel}</span>
          <div class="tm-toggle" role="group" aria-label=${strings.themeMaker.turnSignalStyleLabel}>
            ${TURN_SIGNAL_STYLES.map(
              (style) =>
                html`<button
                  key=${style}
                  class=${`btn tm-toggle-btn ${model.turnSignalStyle === style ? "is-active" : ""}`}
                  aria-pressed=${model.turnSignalStyle === style}
                  onClick=${() => onStyle(style)}
                >
                  ${style}
                </button>`,
            )}
          </div>
        </div>

        ${model.turnSignalStyle === "Traditional" &&
        html`<div class="tm-toggle-group">
          <span class="tm-toggle-label">${strings.themeMaker.turnSignalTypeLabel}</span>
          <div class="tm-toggle" role="group" aria-label=${strings.themeMaker.turnSignalTypeLabel}>
            ${["Single Image", "Sequential"].map(
              (type) =>
                html`<button
                  key=${type}
                  class=${`btn tm-toggle-btn ${model.turnSignalType === type ? "is-active" : ""}`}
                  aria-pressed=${model.turnSignalType === type}
                  onClick=${() => onType(type)}
                >
                  ${type}
                </button>`,
            )}
          </div>
        </div>`}

        <${FileField}
          label=${strings.themeMaker.turnSignalBlindspotLabel}
          accept="image/*"
          name=${model.names.turnSignalBlindspot || ""}
          onPick=${onPickBlindspot}
          onClear=${onClearBlindspot}
        />
        <${FileField}
          label=${sequential ? strings.themeMaker.turnSignalFramesLabel : strings.themeMaker.turnSignalMainLabel}
          accept="image/*"
          multiple=${sequential}
          name=${mainName}
          onPick=${onPickMain}
          onClear=${onClearMain}
        />
        ${sequential &&
        model.sequential.length > 0 &&
        html`<button class="btn tm-sequence-btn" onClick=${onSequence}>${strings.themeMaker.sequenceOrder}</button>`}
      </div>
    </section>
  `;
}

function SequenceModal({ files, onReorder, onClose }) {
  // Object URLs for the frame previews are created once on mount (so a parent re-render cannot orphan a
  // URL) and ALL revoked in the cleanup — the #1 leak class for this view (B5 contract §15.1).
  const urlsRef = useRef([]);
  const [previews, setPreviews] = useState([]);
  const [dragIndex, setDragIndex] = useState(null);

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    urlsRef.current = urls;
    setPreviews(urls);

    return () => {
      for (const url of urlsRef.current) {
        URL.revokeObjectURL(url);
      }
      urlsRef.current = [];
    };
  }, []);

  const move = (from, to) => {
    if (from === to || from === null) {
      return;
    }

    const next = [...files];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);

    const nextUrls = [...urlsRef.current];
    const [movedUrl] = nextUrls.splice(from, 1);
    nextUrls.splice(to, 0, movedUrl);
    urlsRef.current = nextUrls;
    setPreviews(nextUrls);
  };

  return html`
    <${Modal}
      title=${strings.themeMaker.sequenceTitle}
      cancelLabel=${strings.common.close}
      confirmLabel=${strings.common.close}
      onCancel=${onClose}
      onConfirm=${onClose}
    >
      <ul class="tm-sequence" aria-label=${strings.themeMaker.sequenceTitle}>
        ${files.map(
          (file, index) =>
            html`<li
              key=${`${file.name}-${index}`}
              class="tm-sequence-item"
              draggable="true"
              onDragStart=${() => setDragIndex(index)}
              onDragOver=${(event) => event.preventDefault()}
              onDrop=${() => {
                move(dragIndex, index);
                setDragIndex(null);
              }}
              onDragEnd=${() => setDragIndex(null)}
            >
              <img class="tm-sequence-preview" src=${previews[index] || ""} alt=${file.name} />
              <span class="tm-sequence-name">${file.name}</span>
            </li>`,
        )}
      </ul>
    <//>
  `;
}
