/**
 * format.mjs — turns raw numbers and times into the text people read in reports and printouts.
 *
 * What:    Results store raw numbers (28810, 0.0000166, ISO times); people read "28,810", "0.002 %",
 *          "14:31:02" and "10m 0s". All formatting lives here so every report looks the same.
 * How:     import { formatNumber, formatClock, formatSeconds } from './format.mjs';
 * Needs:   Nothing (local time zone of the machine for clock times).
 * Outputs: Strings; "n/a" for null/undefined values so a report never prints "null".
 */

/** Text shown for a value that does not apply or was not measured. */
export const NOT_AVAILABLE = 'n/a';

/**
 * Number with thousands separators and at most `decimals` decimals, e.g. 28810 → "28,810".
 * Why: big event counts are unreadable without separators.
 * @param {number|null|undefined} value
 * @param {number} [decimals] maximum decimals (trailing zeros are dropped)
 * @returns {string}
 */
export function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return NOT_AVAILABLE;
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: decimals });
}

/**
 * Ratio as a percentage, e.g. 0.000366 → "0.037%".
 * Why: shares (dropped, failed) are stored as ratios but read as percentages.
 * @param {number|null|undefined} ratio
 * @param {number} [decimals]
 * @returns {string}
 */
export function formatPercent(ratio, decimals = 3) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return NOT_AVAILABLE;
  return `${formatNumber(ratio * 100, decimals)}%`;
}

/**
 * Rate with its unit, e.g. 199.99 → "199.99/s".
 * Why: every rate in a report carries "/s" so it cannot be mistaken for a count.
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatRate(value) {
  if (value === null || value === undefined) return NOT_AVAILABLE;
  return `${formatNumber(value, 2)}/s`;
}

/**
 * Duration in seconds as people type it, e.g. 600 → "10m 0s", 30 → "30s", 0.2 → "200ms".
 * Why: same style as lib/duration.js formatDuration, without importing k6 code into reports.
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
export function formatSeconds(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return NOT_AVAILABLE;
  if (seconds > 0 && seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  // One decimal is enough for report durations (742.1 s → "12m 22.1s").
  const rest = Math.round((seconds % 60) * 10) / 10;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

/** Pads a number to two digits; why: clock times are always HH:MM:SS. */
function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/**
 * ISO-8601 time WITH the local offset, e.g. "2026-11-05T14:22:33.000+05:30".
 * Why: results must say which clock they were measured on (plan §5.2); toISOString() is always UTC.
 * @param {Date|number|string} [date]
 * @returns {string}
 */
export function toIsoWithOffset(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  // getTimezoneOffset is minutes BEHIND UTC (India: -330), so the sign is inverted.
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * Local clock time "HH:MM:SS" of an ISO time.
 * Why: reports say "started breaking at 14:31:02"; the date is in the report header.
 * @param {string|number|Date|null|undefined} iso
 * @returns {string}
 */
export function formatClock(iso) {
  if (iso === null || iso === undefined) return NOT_AVAILABLE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NOT_AVAILABLE;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Local date "yyyy-mm-dd" of an ISO time.
 * Why: report headers show the date once; every other time is a clock time.
 * @param {string|number|Date|null|undefined} iso
 * @returns {string}
 */
export function formatDate(iso) {
  if (iso === null || iso === undefined) return NOT_AVAILABLE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NOT_AVAILABLE;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Compact local timestamp "yyyymmdd-hhmmss" (run ids, results folder names).
 * Why: sorts correctly as text and contains no characters a file system or SQL LIKE dislikes.
 * @param {Date} [date]
 * @returns {string}
 */
export function formatStamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Bytes in GB/MB, e.g. 1610612736 → "1.5 GB".
 * Why: database sizes are reported in bytes and read in GB.
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return NOT_AVAILABLE;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${formatNumber(gb, 1)} GB`;
  return `${formatNumber(bytes / 1024 ** 2, 1)} MB`;
}

/**
 * Renders a Markdown table from a header row and data rows.
 * Why: every report section is a small table; this keeps the pipes and separators consistent.
 * @param {string[]} header
 * @param {Array<Array<string|number>>} rows
 * @returns {string}
 */
export function markdownTable(header, rows) {
  // A pipe inside a cell would split it; escape it.
  const cell = (value) => String(value ?? NOT_AVAILABLE).replaceAll('|', '\\|');
  const lines = [`| ${header.map(cell).join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  return lines.join('\n');
}
