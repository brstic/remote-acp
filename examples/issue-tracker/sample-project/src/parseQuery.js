/**
 * Parse a query string ("?q=red+shoes&tag=sale&tag=new") into an object.
 * Repeated keys become arrays. Values are decoded; "+" means a space.
 *
 * @param {string} search
 * @returns {Record<string, string | string[]>}
 */
export function parseQuery(search) {
  const out = Object.create(null);
  const s = String(search ?? "").replace(/^\?/, "");
  if (!s) return out;
  for (const part of s.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? "" : part.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    const value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    const prev = out[key];
    if (prev === undefined) out[key] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else out[key] = [prev, value];
  }
  return out;
}
