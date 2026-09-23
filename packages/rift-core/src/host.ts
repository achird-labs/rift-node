/**
 * The form a host string must take inside a URL authority.
 *
 * A bare IPv6 literal is not a valid URL host — `http://::1:2525` is `TypeError: Invalid URL` —
 * so every URL the SDK builds from a host (the spawned engine's admin URL, an imposter handle's
 * `.url`, the intercept proxy URL, the compat readiness poll) goes through here. The engine-facing
 * `host` value stays bare: the engine accepts both spellings (rift#1137).
 *
 * A zone id (`fe80::1%2`) is kept inside the brackets, as the engine keeps scoped literals; note
 * that WHATWG `URL`, and so `fetch`, rejects a zoned host outright, which no bracketing can fix.
 */
export function hostForUrl(host: string): string {
  if (!host.includes(':')) return host;
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return `[${host}]`;
}
