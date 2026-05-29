import { Icon } from "../../components/Icon.js";
import { html } from "../../lib/html.js";
import { strings } from "../../lib/strings.js";
import { VITAL_ROWS, formatCount, remainingPercent } from "./home_helpers.js";

export function UpdateBanner({ softwareInfo }) {
  if (!softwareInfo?.updateAvailable) {
    return null;
  }

  const detail = [softwareInfo.branchName, softwareInfo.versionDate].filter(Boolean).join(" · ");

  return html`
    <div class="update-banner">
      <span class="ub-icon"><${Icon} name="download" size=${22} /></span>
      <span class="ub-text">
        <div class="ub-title">${strings.home.updateAvailable}</div>
        ${detail ? html`<div class="ub-sub">${detail}</div>` : null}
      </span>
      <a class="btn btn-primary ub-btn" href=${strings.home.updateManagerPath}>
        <${Icon} name="download" size=${17} />
        <span>${strings.home.reviewUpdate}</span>
      </a>
    </div>
  `;
}

export function VitalsCard({ vitals }) {
  const rows = VITAL_ROWS.filter((row) => vitals?.[row.key] != null);

  return html`
    <section class="home-card">
      <h2 class="home-card-title">${strings.home.vitals}</h2>
      ${rows.length === 0
        ? html`<p class="home-card-empty">${strings.home.vitalsEmpty}</p>`
        : html`
            <div class="card-body">
              ${rows.map(
                (row) =>
                  html`<div class="vital" key=${row.key}>
                    <span class="vital-label">${row.label()}</span>
                    <span class=${`vital-value ${row.ok ? "ok" : ""}`}>${vitals[row.key]}</span>
                  </div>`,
              )}
            </div>
          `}
    </section>
  `;
}

export function StorageCard({ diskUsage, footageUsage }) {
  const total = diskUsage?.[0];
  const footage = Array.isArray(footageUsage) ? footageUsage : [];

  return html`
    <section class="home-card">
      <h2 class="home-card-title">${strings.home.storage}</h2>
      <div class="card-body">
        ${total
          ? html`
              <div class="disk">
                <p class="disk-caption">${total.used} ${strings.home.used} ${total.size}</p>
                <div class="disk-track" role="img" aria-label=${`${total.usedPercentage} ${strings.home.used} ${total.size}`}>
                  <div class="disk-overlay" style=${`width: ${remainingPercent(total.usedPercentage)}%`}></div>
                </div>
              </div>
              ${footage.map(
                (entry) =>
                  html`<div class="vital" key=${entry.path}>
                    <span class="vital-label">${entry.label || strings.home.footageStorage}</span>
                    <span class="vital-value">${formatCount(entry.segments)} ${strings.home.segments}</span>
                  </div>`,
              )}
              ${total.free
                ? html`<div class="vital">
                    <span class="vital-label">${strings.home.freeSpace}</span>
                    <span class="vital-value ok">${total.free}</span>
                  </div>`
                : null}
            `
          : html`<p class="home-card-empty">${strings.home.unknown}</p>`}
      </div>
    </section>
  `;
}

export function SoftwareCard({ softwareInfo }) {
  const info = softwareInfo ?? {};
  const maintainer = info.forkMaintainer;
  const fields = [
    [strings.home.branchName, info.branchName],
    [strings.home.build, info.buildEnvironment],
    [strings.home.commitHash, info.commitHash ? info.commitHash.slice(0, 7) : ""],
    [strings.home.versionDate, info.versionDate],
  ];

  return html`
    <section class="home-card">
      <h2 class="home-card-title">${strings.home.softwareInfo}</h2>
      <div class="card-body">
        <dl class="software-grid">
          ${fields.map(
            ([label, value]) =>
              html`<div class="software-field" key=${label}>
                <dt class="software-label">${label}</dt>
                <dd class="software-value">${value || strings.home.unknown}</dd>
              </div>`,
          )}
          <div class="software-field">
            <dt class="software-label">${strings.home.forkMaintainer}</dt>
            <dd class="software-value">
              ${maintainer
                ? html`<a class="gh-link" href=${`https://github.com/${maintainer}`} target="_blank" rel="noopener noreferrer">
                    ${maintainer} <${Icon} name="github" size=${14} />
                  </a>`
                : strings.home.unknown}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  `;
}
