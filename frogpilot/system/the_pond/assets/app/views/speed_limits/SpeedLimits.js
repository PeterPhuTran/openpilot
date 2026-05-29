import { useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

const DOWNLOAD_URL = "/api/speed_limits";
const DOWNLOAD_FILENAME = "speed_limits.json";
const SUBMIT_URL = "https://SpeedLimitFiller.frogpilot.com";

function triggerDownload() {
  // Browser-native download: the anchor click hands the transfer to the browser so the dataset is never
  // read into JS (matches the old Pond behavior and B3's send_file attachment download).
  const link = document.createElement("a");
  link.href = DOWNLOAD_URL;
  link.download = DOWNLOAD_FILENAME;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// The view never fetches on mount and opens no stream/interval/listener/<video>/objectURL, so there is
// no teardown surface and no useEffect cleanup (§11). The static panel renders immediately.
export function SpeedLimits() {
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    if (downloading) {
      return;
    }
    setDownloading(true);

    try {
      // Pre-flight reachability check so an offroad gate (423), a backend error, or an unreachable API
      // surfaces a toast instead of a silent browser failure. The dataset is a small JSON param, so
      // parsing it here is cheap; on success the browser owns the actual save via the anchor click.
      await http.get(DOWNLOAD_URL);

      triggerDownload();
      showToast(strings.speedLimits.downloadStarted);
    } catch (error) {
      showToast(messageFor(error), "error");
    } finally {
      setDownloading(false);
    }
  };

  return html`
    <section class="speed-limits">
      <div class="speed-limits-panel">
        <h1 class="speed-limits-title">${strings.speedLimits.title}</h1>
        <p class="speed-limits-text">${strings.speedLimits.description}</p>
        <div class="speed-limits-actions">
          <button class="btn btn-primary" onClick=${download} disabled=${downloading}>
            <${Icon} name="download" /> <span>${strings.speedLimits.downloadButton}</span>
          </button>
          <a class="speed-limits-link" href=${SUBMIT_URL} target="_blank" rel="noopener noreferrer">
            ${strings.speedLimits.submitLink}
          </a>
        </div>
      </div>
    </section>
  `;
}
