import { useEffect, useState } from "preact/hooks";

import { html } from "../../lib/html.js";
import { http } from "../../lib/http.js";
import { strings } from "../../lib/strings.js";

function InlineLoading() {
  return html`
    <section class="home" aria-busy="true">
      <header class="home-header"><h1 class="home-title">${strings.home.title}</h1></header>
      <p class="home-message home-loading-caption">${strings.home.loading}</p>
    </section>
  `;
}

function InlineError({ retry }) {
  return html`
    <section class="home">
      <header class="home-header"><h1 class="home-title">${strings.home.title}</h1></header>
      <section class="home-card home-error-card" role="alert">
        <div>
          <h2 class="home-card-title">${strings.home.dashboardUnavailable}</h2>
          <p class="home-message">${strings.home.errorLoad}</p>
        </div>
        <div class="home-actions">
          <button class="btn btn-primary" onClick=${retry}>${strings.home.retry}</button>
        </div>
      </section>
    </section>
  `;
}

export function Home() {
  const [stats, setStats] = useState(null);
  const [fallbackUnit, setFallbackUnit] = useState("miles");
  const [views, setViews] = useState(null);
  const [viewFailed, setViewFailed] = useState(false);
  const [viewLoadKey, setViewLoadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let mounted = true;

    setViewFailed(false);
    import(`./HomeStates.js${viewLoadKey ? `?retry=${viewLoadKey}` : ""}`)
      .then((module) => {
        if (mounted) {
          setViews(module);
          setViewFailed(false);
        }
      })
      .catch(() => {
        if (mounted) {
          setViews(null);
          setViewFailed(true);
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [viewLoadKey]);

  useEffect(() => {
    const controller = new AbortController();

    setLoading(true);
    setFailed(false);

    const load = async () => {
      try {
        const [statsResponse, params] = await Promise.all([
          http.get("/api/stats", { signal: controller.signal }),
          http.get("/api/params", { signal: controller.signal }),
        ]);

        setStats(statsResponse);
        setFallbackUnit(params?.IsMetric === "1" ? "kilometers" : "miles");
        setLoading(false);
      } catch {
        if (!controller.signal.aborted) {
          setFailed(true);
          setLoading(false);
        }
      }
    };

    load();

    return () => controller.abort();
  }, [reloadKey]);

  const retry = () => {
    setFailed(false);
    setViewFailed(false);
    setLoading(true);
    setReloadKey((key) => key + 1);
    if (!views || viewFailed) {
      setViewLoadKey((key) => key + 1);
    }
  };

  if (loading) {
    return views ? html`<${views.LoadingSkeleton} />` : html`<${InlineLoading} />`;
  }

  if (failed || viewFailed) {
    return views ? html`<${views.ErrorState} retry=${retry} />` : html`<${InlineError} retry=${retry} />`;
  }

  return views
    ? html`<${views.Dashboard} stats=${stats} fallbackUnit=${fallbackUnit} reload=${retry} />`
    : html`<${InlineLoading} />`;
}
