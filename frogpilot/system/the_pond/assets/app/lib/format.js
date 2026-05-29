const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];
const ORDINAL_SUFFIXES = ["th", "st", "nd", "rd"];

// Dedupes the date/ordinal/size formatting the old components each reimplemented (REWRITE_PLAN §3.4).

export function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}

export function formatTimestamp(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  const month = date.toLocaleString("en-US", { month: "long" });
  const day = date.getDate();
  const hour = date.getHours() % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, "0");
  const meridiem = date.getHours() >= 12 ? "pm" : "am";
  return `${month} ${day}${ordinalSuffix(day)}, ${date.getFullYear()} - ${hour}:${minute}${meridiem}`;
}

export function ordinalSuffix(day) {
  const remainder = day % 100;
  return ORDINAL_SUFFIXES[(remainder - 20) % 10] || ORDINAL_SUFFIXES[remainder] || ORDINAL_SUFFIXES[0];
}
