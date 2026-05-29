import { useEffect, useState } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { Modal } from "../../components/Modal.js";
import { html } from "../../lib/html.js";
import { http, HttpError, messageFor } from "../../lib/http.js";
import { showToast } from "../../lib/toast.js";
import { strings } from "../../lib/strings.js";

function severityLabel(severity) {
  return severity === "error" ? strings.troubleshoot.severityError : strings.troubleshoot.severityWarning;
}

function IssueCard({ issue }) {
  return html`
    <li class=${`troubleshoot-issue troubleshoot-issue-${issue.severity === "error" ? "error" : "warning"}`}>
      <span class="troubleshoot-issue-badge" role="img" aria-label=${severityLabel(issue.severity)}>
        <${Icon} name="alert" />
      </span>
      <div class="troubleshoot-issue-body">
        <span class="troubleshoot-issue-title">${issue.title}</span>
        <span class="troubleshoot-issue-detail">${issue.detail}</span>
      </div>
    </li>
  `;
}

export function Troubleshoot() {
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);

  const reload = () => setReloadKey((key) => key + 1);

  // Mount/reload-only check. The mounted ref drops a late resolve so the cleanup-on-unmount (which aborts
  // the request) never sets state on a dead component (REWRITE_PLAN §3.4, §15.6).
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    setLoading(true);
    setFailed(false);

    http
      .get("/api/troubleshoot", { signal: controller.signal })
      .then((data) => {
        if (mounted) {
          setIssues(data.issues);
          setLoading(false);
        }
      })
      .catch((error) => {
        // An aborted fetch on unmount is expected teardown, not a load failure.
        if (mounted && error.name !== "AbortError") {
          setFailed(true);
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [reloadKey]);

  const reset = async () => {
    setConfirmReset(false);
    try {
      const result = await http.post("/api/troubleshoot/reset");

      showToast(result.message || strings.troubleshoot.resetSuccess);
      reload();
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        showToast(strings.troubleshoot.resetNothing);
        reload();
        return;
      }

      showToast(messageFor(error, strings.troubleshoot.resetFailed), "error");
    }
  };

  const status = renderStatus(failed, loading, issues.length);

  return html`
    <section class="troubleshoot">
      <header class="troubleshoot-header">
        <h1 class="troubleshoot-title">${strings.troubleshoot.title}</h1>
        ${issues.length > 0 &&
        html`<button class="btn btn-danger" onClick=${() => setConfirmReset(true)}>
          <${Icon} name="wrench" /> <span>${strings.troubleshoot.reset}</span>
        </button>`}
      </header>

      ${status
        ? html`
            <p class="troubleshoot-message">${status}</p>
            ${failed &&
            html`<button class="btn btn-primary troubleshoot-retry" onClick=${reload}>${strings.troubleshoot.retry}</button>`}
          `
        : html`
            <ul class="troubleshoot-list">
              ${issues.map((issue) => html`<${IssueCard} key=${issue.id} issue=${issue} />`)}
            </ul>
          `}
      ${confirmReset &&
      html`<${Modal}
        title=${strings.troubleshoot.resetConfirmTitle}
        message=${strings.troubleshoot.resetConfirm}
        confirmLabel=${strings.troubleshoot.reset}
        danger
        onConfirm=${reset}
        onCancel=${() => setConfirmReset(false)}
      />`}
    </section>
  `;
}

function renderStatus(failed, loading, count) {
  if (failed) {
    return strings.troubleshoot.error;
  }

  if (loading) {
    return strings.troubleshoot.loading;
  }

  if (count === 0) {
    return strings.troubleshoot.empty;
  }

  return null;
}
