/**
 * What the pairing screen got: a scanned admin QR (`https://<origin>/pair/<code>`) or 6 typed digits.
 * `origin` is where to pair (the test workspace may live on another host); null = the app's built-in origin.
 */
export function parsePairingInput(raw: string): { code: string; origin: string | null } | null {
  const s = raw.trim();
  const qr = /^(https:\/\/[^/\s]+)\/pair\/(\d{6})\/?$/.exec(s);
  if (qr) return { code: qr[2], origin: qr[1] };
  const typed = s.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(typed) ? { code: typed, origin: null } : null;
}
