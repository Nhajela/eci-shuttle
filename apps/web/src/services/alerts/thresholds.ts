/** Alert thresholds, import-free so UI code (admin-phones' PhoneHealth view) can share them without the db. */

/** A vehicle expected active but with no ping for this long is "silent". */
export const SILENT_AFTER_MS = 5 * 60_000;
/** Battery percent (0..100, as phones report it) below which a phone not charging is flagged. */
export const LOW_BATTERY_PCT = 15;
