import { useEffect, useRef } from "preact/hooks";

import { Icon } from "../../components/Icon.js";
import { html } from "../../lib/html.js";
import { strings } from "../../lib/strings.js";
import { SoftwareCard, StorageCard, UpdateBanner, VitalsCard } from "./HomeDevice.js";
import { DriveStatCard, PersonalRecordsCard, RecentDrivesCard, RouteHero, ThisWeekCard } from "./HomeDriving.js";

function HomeShell({ busy = false, children }) {
  return html`<section class="home" aria-busy=${busy ? "true" : null}>${children}</section>`;
}

function HomeHeader({ reload, status }) {
  return html`
    <header class="home-header">
      <div>
        <h1 class="home-title">${strings.home.title}</h1>
        ${status
          ? html`<div class="home-status">
              <span class="live-dot"></span><span><b>${status}</b> · ${strings.home.synced}</span>
            </div>`
          : null}
      </div>
      <button class="btn" onClick=${reload}>
        <${Icon} name="refresh" size=${16} />
        <span>${strings.home.refresh}</span>
      </button>
    </header>
  `;
}

function DrivingStats({ driveStats, fallbackUnit }) {
  return html`
    <div class="section-label">${strings.home.yourDriving}</div>
    <div class="drive-stats">
      <${DriveStatCard} title=${strings.home.allTime} stats=${driveStats.all} fallbackUnit=${fallbackUnit} />
      <${DriveStatCard} title=${strings.home.pastWeek} stats=${driveStats.week} fallbackUnit=${fallbackUnit} />
      <${DriveStatCard} title=${strings.home.frogpilot} stats=${driveStats.frogpilot} fallbackUnit=${fallbackUnit} accent />
    </div>
  `;
}

function DrivingDetails({ stats, fallbackUnit }) {
  return html`
    <div class="lower-grid">
      <${ThisWeekCard} thisWeek=${stats?.thisWeek} fallbackUnit=${fallbackUnit} />
      <${PersonalRecordsCard} records=${stats?.records} />
    </div>
    <${RecentDrivesCard} recentDrives=${stats?.recentDrives} fallbackUnit=${fallbackUnit} />
  `;
}

function DeviceSection({ stats }) {
  return html`
    <div class="section-label">${strings.home.yourDevice}</div>
    <${UpdateBanner} softwareInfo=${stats?.softwareInfo} />
    <div class="device-grid">
      <${VitalsCard} vitals=${stats?.vitals} />
      <${StorageCard} diskUsage=${stats?.diskUsage} footageUsage=${stats?.footageUsage} />
      <${SoftwareCard} softwareInfo=${stats?.softwareInfo} />
    </div>
  `;
}

export function LoadingSkeleton() {
  return html`
    <${HomeShell} busy>
      <header class="home-header"><h1 class="home-title">${strings.home.title}</h1></header>
      <p class="home-message home-loading-caption">${strings.home.loading}</p>
      <section class="home-card route-hero home-loading-route" aria-hidden="true">
        <div class="route-map route-map-loading">
          <span class="loading-pill"></span>
          <span class="loading-route-line loading-route-line-a"></span>
          <span class="loading-route-line loading-route-line-b"></span>
          <span class="loading-route-line loading-route-line-c"></span>
          <div class="loading-route-footer">
            <span></span>
            <b></b>
          </div>
        </div>
      </section>
      <div class="section-label">${strings.home.yourDriving}</div>
      <div class="drive-stats" aria-hidden="true">
        ${[0, 1, 2].map(
          (index) => html`
            <div class="drive-stat home-loading-stat" key=${index}>
              <span class="loading-line loading-line-title"></span>
              <div class="drive-stat-grid">
                <span class="loading-metric"></span>
                <span class="loading-metric"></span>
                <span class="loading-metric"></span>
              </div>
              <span class="loading-spark"></span>
            </div>
          `,
        )}
      </div>
      <div class="lower-grid" aria-hidden="true">
        <section class="home-card home-loading-card"><span class="loading-block"></span></section>
        <section class="home-card home-loading-card"><span class="loading-block"></span></section>
      </div>
      <div class="section-label">${strings.home.yourDevice}</div>
      <div class="device-grid" aria-hidden="true">
        <section class="home-card home-loading-card"><span class="loading-block"></span></section>
        <section class="home-card home-loading-card"><span class="loading-block"></span></section>
        <section class="home-card home-loading-card"><span class="loading-block"></span></section>
      </div>
    <//>
  `;
}

export function ErrorState({ retry }) {
  const retryRef = useRef(null);

  useEffect(() => {
    retryRef.current?.focus();
  }, []);

  return html`
    <${HomeShell}>
      <header class="home-header"><h1 class="home-title">${strings.home.title}</h1></header>
      <section class="home-card home-error-card" role="alert" aria-labelledby="home-error-title">
        <span class="home-error-icon"><${Icon} name="alert" size=${24} /></span>
        <div>
          <h2 id="home-error-title" class="home-card-title">${strings.home.dashboardUnavailable}</h2>
          <p class="home-message">${strings.home.errorLoad}</p>
        </div>
        <div class="home-actions">
          <button ref=${retryRef} class="btn btn-primary" onClick=${retry}>${strings.home.retry}</button>
        </div>
      </section>
    <//>
  `;
}

export function Dashboard({ stats, fallbackUnit, reload }) {
  const driveStats = stats?.driveStats ?? {};

  return html`
    <${HomeShell}>
      <${HomeHeader} reload=${reload} status=${stats?.vitals?.status} />
      <${RouteHero} lastDrive=${stats?.lastDrive} />
      <${DrivingStats} driveStats=${driveStats} fallbackUnit=${fallbackUnit} />
      <${DrivingDetails} stats=${stats} fallbackUnit=${fallbackUnit} />
      <${DeviceSection} stats=${stats} />
    <//>
  `;
}
