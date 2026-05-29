import { useEffect, useState } from "preact/hooks";

import { strings } from "../../lib/strings.js";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export const RING_RADIUS = 52;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export const RECORD_SLOTS = [
  { icon: "route", key: "longestDrive", label: () => strings.home.recordLongestDrive },
  { icon: "check-circle", key: "mostEngagedDay", label: () => strings.home.recordMostEngaged },
  { icon: "trending-up", key: "bestWeek", label: () => strings.home.recordBestWeek },
  { icon: "flame", key: "highestStreak", label: () => strings.home.recordHighestStreak },
];

export const VITAL_ROWS = [
  { key: "status", label: () => strings.home.vitalStatus, ok: true },
  { key: "uptime", label: () => strings.home.vitalUptime, ok: false },
  { key: "cpuTemp", label: () => strings.home.vitalCpuTemp, ok: false },
  { key: "network", label: () => strings.home.vitalNetwork, ok: true },
  { key: "gps", label: () => strings.home.vitalGps, ok: true },
];

function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function useCountUp(target, duration = 800) {
  const finite = typeof target === "number" && Number.isFinite(target);
  const [value, setValue] = useState(finite && !prefersReducedMotion() ? 0 : target);

  useEffect(() => {
    if (!finite || prefersReducedMotion()) {
      setValue(target);
      return undefined;
    }

    let frame = 0;
    let startTs = 0;
    const step = (ts) => {
      startTs ||= ts;
      const progress = Math.min(1, (ts - startTs) / duration);
      setValue(target * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) {
        frame = requestAnimationFrame(step);
      }
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, finite]);

  return value;
}

export function formatCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? NUMBER_FORMAT.format(Math.round(value)) : "0";
}

export function unitFor(stats, fallbackUnit) {
  return stats?.unit ?? fallbackUnit;
}

export function remainingPercent(usedPercentage) {
  const used = Number.parseFloat(usedPercentage);
  if (!Number.isFinite(used)) {
    return 100;
  }

  return Math.min(100, Math.max(0, 100 - used));
}

export function clampPercentValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.min(100, Math.max(0, number));
}
