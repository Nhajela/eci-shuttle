type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" ? (v as Obj) : null);

function parse(v: unknown): Obj | null {
  if (typeof v !== "string") return obj(v);
  try {
    return obj(JSON.parse(v));
  } catch {
    return null;
  }
}

/**
 * True when a background notification task payload is the server's "sync now" push ({ type: "sync" }).
 * Android delivers the data as an object, or as a JSON string in `dataString` / Expo's `body` depending on version.
 */
export function isSyncPush(payload: unknown): boolean {
  const p = obj(payload);
  const content = obj(obj(obj(p?.notification)?.request)?.content);
  const data = obj(p?.data) ?? obj(content?.data);
  return [data, parse(data?.dataString), parse(data?.body)].some((d) => d?.type === "sync");
}
