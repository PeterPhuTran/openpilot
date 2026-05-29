import { useEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { http, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

// The fixed marketing/download page Tailscale hosts for installing the client on a phone or PC. Not
// translatable copy, so it lives here as a constant rather than in strings.js (only its label is a
// string).
const DOWNLOAD_URL = "https://tailscale.com/download";

// The login URL setup() hands back comes from `tailscale up` itself, but the old app assigned it to
// window.location blindly (REWRITE_PLAN §3.3). Render it only after confirming it is an https Tailscale
// login URL, and open it in a vetted new tab — never a blind redirect.
function safeAuthUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "login.tailscale.com" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    // Not a parseable absolute URL; refuse to surface it.
    return null;
  }
}

export function Tailscale() {
  const [installed, setInstalled] = useState(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [authUrl, setAuthUrl] = useState(null);
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [busy, setBusy] = useState(false);

  // One-shot fetches with no stream/interval/listener/<video>/objectURL, so the only teardown surface is
  // ignoring a late resolve after unmount: a mid-request navigation must not call setState on a dead
  // component. The Modal owns its own focus-trap/scroll-lock/focus-restore.
  const mounted = useRef(true);

  const refreshStatus = async () => {
    try {
      const status = await http.get("/api/tailscale/installed");
      if (mounted.current) {
        setInstalled(Boolean(status.installed));
        setStatusFailed(false);
      }
    } catch (error) {
      if (mounted.current) {
        setStatusFailed(true);
        showToast(messageFor(error, strings.tailscale.statusError), "error");
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    refreshStatus();

    return () => {
      mounted.current = false;
    };
  }, []);

  const install = async () => {
    setBusy(true);
    setAuthUrl(null);

    try {
      const result = await http.post("/api/tailscale/setup");
      if (!mounted.current) {
        return;
      }

      setAuthUrl(safeAuthUrl(result.auth_url));
      showToast(strings.tailscale.installStarted);
      await refreshStatus();
    } catch (error) {
      if (mounted.current) {
        showToast(messageFor(error, strings.tailscale.installError), "error");
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  };

  const uninstall = async () => {
    setConfirmingUninstall(false);
    setBusy(true);

    try {
      await http.post("/api/tailscale/uninstall");
      if (!mounted.current) {
        return;
      }

      setAuthUrl(null);
      showToast(strings.tailscale.uninstallStarted);
      await refreshStatus();
    } catch (error) {
      if (mounted.current) {
        showToast(messageFor(error, strings.tailscale.uninstallError), "error");
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  };

  return html`
    <section class="tailscale">
      <div class="tailscale-panel">
        <h1 class="tailscale-title">${strings.tailscale.title}</h1>
        <p class="tailscale-text">${strings.tailscale.description}</p>

        ${installed === null && !statusFailed && html`<p class="tailscale-status">${strings.tailscale.loading}</p>`}
        ${statusFailed && html`<p class="tailscale-status tailscale-status-error">${strings.tailscale.statusError}</p>`}
        ${installed === true && html`<p class="tailscale-status">${strings.tailscale.installed}</p>`}
        ${installed === false && html`<p class="tailscale-status">${strings.tailscale.notInstalled}</p>`}

        <div class="tailscale-actions">
          ${installed === false &&
          html`<button class="btn btn-primary" onClick=${install} disabled=${busy}>
            <${Icon} name="wifi" /> <span>${strings.tailscale.installButton}</span>
          </button>`}
          ${installed === true &&
          html`<button class="btn btn-danger" onClick=${() => setConfirmingUninstall(true)} disabled=${busy}>
            <${Icon} name="trash" /> <span>${strings.tailscale.uninstallButton}</span>
          </button>`}
        </div>

        ${authUrl &&
        html`<div class="tailscale-auth">
          <p class="tailscale-auth-prompt">${strings.tailscale.authPrompt}</p>
          <a class="btn btn-primary" href=${authUrl} target="_blank" rel="noopener noreferrer">
            <span>${strings.tailscale.openLoginButton}</span>
          </a>
        </div>`}

        <a class="tailscale-download" href=${DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
          <${Icon} name="download" /> <span>${strings.tailscale.downloadLink}</span>
        </a>
      </div>

      ${confirmingUninstall &&
      html`<${Modal}
        title=${strings.tailscale.uninstallConfirmTitle}
        message=${strings.tailscale.uninstallConfirmBody}
        confirmLabel=${strings.tailscale.uninstallConfirmConfirm}
        danger
        onConfirm=${uninstall}
        onCancel=${() => setConfirmingUninstall(false)}
      />`}
    </section>
  `;
}
