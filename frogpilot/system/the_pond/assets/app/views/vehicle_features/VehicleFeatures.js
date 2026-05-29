import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

// The Yes/No capability rows, declared once so the order is stable and the panel reads the booleans by
// key off car_features_check. Brand facts (is*) are intentionally NOT shown here: they exist on the
// payload so the panel can avoid re-deriving brand rules client-side, but B17 only surfaces the
// detected capabilities + the forced-fingerprint flow (REWRITE_PLAN §4.2).
const CAPABILITY_ROWS = [
  { key: "blindSpotSupport", label: strings.vehicleFeatures.blindSpotSupport },
  { key: "openpilotLongitudinalSupport", label: strings.vehicleFeatures.openpilotLongitudinalSupport },
  { key: "pedalSupport", label: strings.vehicleFeatures.pedalSupport },
  { key: "radarSupport", label: strings.vehicleFeatures.radarSupport },
  { key: "sdsuSupport", label: strings.vehicleFeatures.sdsuSupport },
  { key: "stopAndGoSupport", label: strings.vehicleFeatures.stopAndGoSupport },
];

function CapabilityRow({ label, value }) {
  return html`
    <div class="vehicle-fact">
      <span class="vehicle-fact-label">${label}</span>
      <span class="vehicle-fact-value">${value ? strings.vehicleFeatures.yes : strings.vehicleFeatures.no}</span>
    </div>
  `;
}

function CapabilitiesPanel({ features }) {
  const hardware = features.detectedHardware.length > 0 ? features.detectedHardware.join(", ") : strings.vehicleFeatures.none;

  return html`
    <div class="vehicle-panel">
      <h2 class="vehicle-panel-title">${strings.vehicleFeatures.detectedCapabilities}</h2>
      <div class="vehicle-facts">
        <div class="vehicle-fact">
          <span class="vehicle-fact-label">${strings.vehicleFeatures.makeLabel}</span>
          <span class="vehicle-fact-value">${features.carMake || strings.vehicleFeatures.notDetected}</span>
        </div>
        <div class="vehicle-fact">
          <span class="vehicle-fact-label">${strings.vehicleFeatures.modelLabel}</span>
          <span class="vehicle-fact-value">${features.carFingerprint || strings.vehicleFeatures.notDetected}</span>
        </div>
        <div class="vehicle-fact">
          <span class="vehicle-fact-label">${strings.vehicleFeatures.carModelName}</span>
          <span class="vehicle-fact-value">${features.carModelName || strings.vehicleFeatures.none}</span>
        </div>
        <div class="vehicle-fact">
          <span class="vehicle-fact-label">${strings.vehicleFeatures.detectedHardware}</span>
          <span class="vehicle-fact-value">${hardware}</span>
        </div>
        ${CAPABILITY_ROWS.map((row) => html`<${CapabilityRow} key=${row.key} label=${row.label} value=${features[row.key]} />`)}
      </div>
    </div>
  `;
}

export function VehicleFeatures() {
  const [features, setFeatures] = useState(null);
  const [featuresFailed, setFeaturesFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [makes, setMakes] = useState([]);
  const [selectedMake, setSelectedMake] = useState("");
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);

  const [inFlight, setInFlight] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // A late resolve after unmount must not set state on a dead component. Each network branch checks the
  // ref before committing; the make→models fetch additionally tracks its own AbortController so a rapid
  // make change or an unmount cancels the in-flight listing (REWRITE_PLAN §3.4, §15.6).
  const mountedRef = useRef(true);
  const modelsControllerRef = useRef(null);

  const reloadFeatures = () => setReloadKey((key) => key + 1);

  // Mount/reload-only: fetch the detected capabilities + the make list together. The capabilities panel
  // is refetched after a force/clear (via reloadKey) so the forced-model row stays in sync; the make list
  // is static so refetching it on reload is harmless and keeps the effect single-purpose.
  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();

    setFeaturesFailed(false);

    http
      .get("/api/car_features_check", { signal: controller.signal })
      .then((data) => {
        if (mountedRef.current) {
          setFeatures(data);
        }
      })
      .catch((error) => {
        if (mountedRef.current && error.name !== "AbortError") {
          setFeaturesFailed(true);
          showToast(messageFor(error, strings.vehicleFeatures.loadError), "error");
        }
      });

    http
      .get("/api/fingerprints/makes", { signal: controller.signal })
      .then((data) => {
        if (mountedRef.current) {
          setMakes(data);
        }
      })
      .catch((error) => {
        if (mountedRef.current && error.name !== "AbortError") {
          showToast(messageFor(error, strings.vehicleFeatures.makesError), "error");
        }
      });

    return () => {
      controller.abort();
    };
  }, [reloadKey]);

  // Releasing the make→models controller and the mounted flag is a separate mount-only effect so the
  // reload-driven effect above never tears it down mid-flight.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      modelsControllerRef.current?.abort();
    };
  }, []);

  const chooseMake = async (make) => {
    setSelectedMake(make);
    setSelectedModel("");
    setModels([]);
    modelsControllerRef.current?.abort();

    if (!make) {
      return;
    }

    const controller = new AbortController();
    modelsControllerRef.current = controller;
    setModelsLoading(true);

    try {
      const data = await http.get(`/api/fingerprints/models?make=${encodeURIComponent(make)}`, { signal: controller.signal });
      if (mountedRef.current) {
        setModels(data);
      }
    } catch (error) {
      if (mountedRef.current && error.name !== "AbortError") {
        showToast(messageFor(error, strings.vehicleFeatures.modelsError), "error");
      }
    } finally {
      if (mountedRef.current && modelsControllerRef.current === controller) {
        setModelsLoading(false);
      }
    }
  };

  const force = async () => {
    const model = models.find((entry) => entry.platform === selectedModel);
    if (!model) {
      return;
    }

    setInFlight(true);
    try {
      await http.post("/api/fingerprints", { make: selectedMake, model: model.platform, name: model.name });
      if (mountedRef.current) {
        showToast(strings.vehicleFeatures.forced);
        reloadFeatures();
      }
    } catch (error) {
      if (mountedRef.current) {
        showToast(messageFor(error, strings.vehicleFeatures.setError), "error");
      }
    } finally {
      if (mountedRef.current) {
        setInFlight(false);
      }
    }
  };

  const clear = async () => {
    setConfirmClear(false);
    setInFlight(true);
    try {
      await http.del("/api/fingerprints");
      if (mountedRef.current) {
        showToast(strings.vehicleFeatures.cleared);
        reloadFeatures();
      }
    } catch (error) {
      if (mountedRef.current) {
        showToast(messageFor(error, strings.vehicleFeatures.clearError), "error");
      }
    } finally {
      if (mountedRef.current) {
        setInFlight(false);
      }
    }
  };

  return html`
    <section class="vehicle">
      <header class="vehicle-header">
        <h1 class="vehicle-title">${strings.vehicleFeatures.title}</h1>
      </header>

      ${featuresFailed
        ? html`<p class="vehicle-message">${strings.vehicleFeatures.loadError}</p>`
        : features === null
          ? html`<p class="vehicle-message">${strings.vehicleFeatures.loading}</p>`
          : html`<${CapabilitiesPanel} features=${features} />`}

      <div class="vehicle-panel">
        <h2 class="vehicle-panel-title">${strings.vehicleFeatures.forceFingerprint}</h2>
        <p class="vehicle-text">${strings.vehicleFeatures.forceIntro}</p>

        <div class="vehicle-form">
          <div class="vehicle-field">
            <span class="vehicle-field-label" id="vehicle-make-label">${strings.vehicleFeatures.makeLabel}</span>
            <select
              class="vehicle-select"
              aria-labelledby="vehicle-make-label"
              value=${selectedMake}
              disabled=${inFlight || makes.length === 0}
              onChange=${(event) => chooseMake(event.target.value)}
            >
              <option value="">${strings.vehicleFeatures.selectMakePlaceholder}</option>
              ${makes.map((make) => html`<option key=${make} value=${make}>${make}</option>`)}
            </select>
          </div>

          <div class="vehicle-field">
            <span class="vehicle-field-label" id="vehicle-model-label">${strings.vehicleFeatures.modelLabel}</span>
            <select
              class="vehicle-select"
              aria-labelledby="vehicle-model-label"
              value=${selectedModel}
              disabled=${inFlight || modelsLoading || models.length === 0}
              onChange=${(event) => setSelectedModel(event.target.value)}
            >
              <option value="">${strings.vehicleFeatures.selectModelPlaceholder}</option>
              ${models.map((model) => html`<option key=${model.platform} value=${model.platform}>${model.name}</option>`)}
            </select>
          </div>
        </div>

        <div class="vehicle-actions">
          <button class="btn btn-primary" onClick=${force} disabled=${inFlight || !selectedModel}>
            <${Icon} name="car" /> <span>${strings.vehicleFeatures.setButton}</span>
          </button>
          <button class="btn btn-danger" onClick=${() => setConfirmClear(true)} disabled=${inFlight}>
            <${Icon} name="trash" /> <span>${strings.vehicleFeatures.clearButton}</span>
          </button>
        </div>
      </div>

      ${confirmClear &&
      html`<${Modal}
        title=${strings.vehicleFeatures.clearConfirmTitle}
        message=${strings.vehicleFeatures.clearConfirm}
        confirmLabel=${strings.vehicleFeatures.clearButton}
        danger
        onConfirm=${clear}
        onCancel=${() => setConfirmClear(false)}
      />`}
    </section>
  `;
}
