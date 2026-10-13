/** Escape text for Telegram's HTML parse mode (and attribute values). `&` first, so nothing is double-escaped. */
export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
