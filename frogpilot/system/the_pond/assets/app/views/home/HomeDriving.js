import { Icon } from "../../components/Icon.js";
import { html } from "../../lib/html.js";
import { strings } from "../../lib/strings.js";
import {
  RING_CIRCUMFERENCE,
  RING_RADIUS,
  RECORD_SLOTS,
  clampPercentValue,
  formatCount,
  unitFor,
  useCountUp,
} from "./home_helpers.js";

function StatValue({ value }) {
  const animated = useCountUp(typeof value === "number" && Number.isFinite(value) ? value : 0);
  return html`<span class="drive-stat-value">${formatCount(animated)}</span>`;
}

export function DriveStatCard({ title, stats, fallbackUnit, accent }) {
  return html`
    <div class=${`drive-stat ${accent ? "drive-stat-accent" : ""}`}>
      <h2 class="drive-stat-title">${title}</h2>
      <div class="drive-stat-grid">
        <div class="drive-stat-cell">
          <${StatValue} value=${stats?.drives} />
          <span class="drive-stat-label">${strings.home.drives}</span>
        </div>
        <div class="drive-stat-cell">
          <${StatValue} value=${stats?.distance} />
          <span class="drive-stat-label">${unitFor(stats, fallbackUnit)}</span>
        </div>
        <div class="drive-stat-cell">
          <${StatValue} value=${stats?.hours} />
          <span class="drive-stat-label">${strings.home.hours}</span>
        </div>
      </div>
    </div>
  `;
}

function RouteStats({ lastDrive }) {
  const distanceUnit = lastDrive.distanceUnit ?? "";
  const speedUnit = lastDrive.speedUnit ?? "";
  const engagement = clampPercentValue(lastDrive.engagement);

  return html`
    <div class="route-stats">
      ${Number.isFinite(lastDrive.distance)
        ? html`<div class="route-stat"><b>${lastDrive.distance}</b><span>${distanceUnit}</span></div>`
        : null}
      ${Number.isFinite(lastDrive.durationMin)
        ? html`<div class="route-stat"><b>${lastDrive.durationMin}</b><span>${strings.home.minutes}</span></div>`
        : null}
      ${Number.isFinite(lastDrive.avgSpeed)
        ? html`<div class="route-stat"><b>${lastDrive.avgSpeed}</b><span>${speedUnit} ${strings.home.avg}</span></div>`
        : null}
      ${engagement !== null
        ? html`<div class="route-stat route-stat-accent">
            <b>${Math.round(engagement)}%</b><span>${strings.home.engaged}</span>
          </div>`
        : null}
    </div>
  `;
}

function LastDriveSummary({ lastDrive }) {
  // The map hero was dropped: the on-device GPS logs carry no usable fix, so there is no route path to
  // draw. This shows the last drive's real stats (distance / duration / avg speed / engagement) instead.
  return html`
    <section class="home-card route-hero">
      <div class="route-summary">
        <span class="route-top"><span class="live-dot"></span> ${strings.home.lastDrive}</span>
        ${lastDrive.when ? html`<div class="route-when">${lastDrive.when}</div>` : null}
        <${RouteStats} lastDrive=${lastDrive} />
      </div>
    </section>
  `;
}

function EmptyRouteHero() {
  return html`
    <section class="home-card route-hero">
      <div class="route-empty">
        <${Icon} name="route" size=${28} />
        <p>${strings.home.lastDriveEmpty}</p>
      </div>
    </section>
  `;
}

export function RouteHero({ lastDrive }) {
  return lastDrive ? html`<${LastDriveSummary} lastDrive=${lastDrive} />` : html`<${EmptyRouteHero} />`;
}

function WeekRing({ engagement }) {
  const pct = Math.max(0, Math.min(100, Number(engagement) || 0));
  const offset = RING_CIRCUMFERENCE * (1 - pct / 100);

  return html`
    <svg
      class="ring"
      width="108"
      height="108"
      viewBox="0 0 120 120"
      role="img"
      aria-label=${strings.home.weekEngagedAria(Math.round(pct))}
    >
      <circle class="track" cx="60" cy="60" r=${RING_RADIUS} fill="none" stroke-width="11"></circle>
      <circle
        class="val"
        cx="60"
        cy="60"
        r=${RING_RADIUS}
        fill="none"
        stroke-width="11"
        stroke-linecap="round"
        stroke-dasharray=${RING_CIRCUMFERENCE.toFixed(1)}
        stroke-dashoffset=${offset.toFixed(1)}
        transform="rotate(-90 60 60)"
      ></circle>
      <text x="60" y="57" text-anchor="middle" fill="var(--color-text)" font-size="27" font-weight="700">
        ${Math.round(pct)}%
      </text>
      <text x="60" y="77" text-anchor="middle" fill="var(--color-text-muted)" font-size="11">${strings.home.engaged}</text>
    </svg>
  `;
}

export function ThisWeekCard({ thisWeek, fallbackUnit }) {
  const perDay = Array.isArray(thisWeek?.perDay) ? thisWeek.perDay : [];
  const totals = thisWeek?.totals;
  const distanceUnit = unitFor({ unit: totals?.distanceUnit }, fallbackUnit);

  if (!thisWeek || (perDay.length === 0 && !totals)) {
    return html`
      <section class="home-card">
        <h2 class="home-card-title">${strings.home.thisWeek}</h2>
        <p class="home-card-empty">${strings.home.thisWeekEmpty}</p>
      </section>
    `;
  }

  const maxMiles = perDay.reduce((max, day) => Math.max(max, Number(day?.miles) || 0), 0) || 1;

  return html`
    <section class="home-card">
      <h2 class="home-card-title">${strings.home.thisWeek}</h2>
      <div class="week">
        <div class="week-top">
          <${WeekRing} engagement=${thisWeek.engagement} />
          ${totals
            ? html`
                <div class="week-sum">
                  <div><b>${formatCount(totals.distance)}</b><span>${distanceUnit}</span></div>
                  <div><b>${totals.hours ?? 0}</b><span>${strings.home.hours}</span></div>
                  <div><b>${formatCount(totals.drives)}</b><span>${strings.home.drives}</span></div>
                </div>
              `
            : null}
        </div>
        ${perDay.length > 0
          ? html`
              <div class="week-chart">
                <div class="bars-cap">${strings.home.distancePerDay(distanceUnit)}</div>
                <div class="bars">
                  ${perDay.map(
                    (day, index) =>
                      html`<div class=${`bar ${day?.today ? "today" : ""}`} key=${day?.label ?? index}>
                        <i style=${`height: ${((Number(day?.miles) || 0) / maxMiles) * 100}%`}></i>
                        <span>${day?.label ?? ""}</span>
                      </div>`,
                  )}
                </div>
              </div>
            `
          : null}
      </div>
    </section>
  `;
}

export function PersonalRecordsCard({ records }) {
  const slots = RECORD_SLOTS.filter((slot) => records?.[slot.key]);

  return html`
    <section class="home-card">
      <h2 class="home-card-title">${strings.home.personalRecords}</h2>
      ${slots.length === 0
        ? html`<p class="home-card-empty">${strings.home.personalRecordsEmpty}</p>`
        : html`
            <div class="card-body">
              ${slots.map((slot) => {
                const record = records[slot.key];
                return html`<div class="record" key=${slot.key}>
                  <span class="record-ico"><${Icon} name=${slot.icon} size=${18} /></span>
                  <div class="record-body">
                    <div class="record-lbl">${slot.label()}</div>
                    <div class="record-val">${record.value}${record.detail ? html` <span>· ${record.detail}</span>` : null}</div>
                  </div>
                </div>`;
              })}
            </div>
          `}
    </section>
  `;
}

export function RecentDrivesCard({ recentDrives, fallbackUnit }) {
  const drives = Array.isArray(recentDrives) ? recentDrives : [];

  return html`
    <section class="home-card">
      <div class="feed-head"><h2 class="home-card-title">${strings.home.recentDrives}</h2></div>
      ${drives.length === 0
        ? html`<p class="home-card-empty">${strings.home.recentDrivesEmpty}</p>`
        : drives.map((drive, index) => {
            const engagement = clampPercentValue(drive?.engagement);
            return html`<div class="drive" key=${drive?.id ?? index}>
              <span class="drive-when">${drive?.when ?? ""}</span>
              <span class="drive-meta">
                ${Number.isFinite(drive?.distance)
                  ? html`<span><b>${drive.distance}</b> ${drive.distanceUnit ?? unitFor(null, fallbackUnit)}</span>`
                  : null}
                ${drive?.duration ? html`<span><b>${drive.duration}</b></span>` : null}
                ${Number.isFinite(drive?.segments)
                  ? html`<span><b>${formatCount(drive.segments)}</b> ${strings.home.segments}</span>`
                  : null}
              </span>
              ${engagement !== null
                ? html`<span class="drive-eng">
                    <span class="eng-bar"><i style=${`width: ${engagement}%`}></i></span>
                    <span><span class="eng-pct">${Math.round(engagement)}%</span> ${strings.home.engaged}</span>
                  </span>`
                : null}
            </div>`;
          })}
    </section>
  `;
}
