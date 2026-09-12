/**
 * Error messages from RPC clients quote the request URL, and a keyed RPC URL carries the key in its
 * query string. Every message that leaves the server passes through here first, so a
 * misconfigured variable can never print a credential on a public page.
 */
const KEYISH = /([?&](?:api[-_]?key|apikey|key|token|auth|access[-_]?token)=)[^&\s"']+/gi;
const HEX_KEY = /\b(0x)?[0-9a-fA-F]{64}\b/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._-]{8,}/g;

export function redact(text: string): string {
  return text
    .replace(KEYISH, "$1…")
    .replace(BEARER, "$1…")
    // a URL path segment that is itself the key (https://host/v2/<key>): keep the host, drop the rest
    .replace(/(https?:\/\/[^/\s"']+)\/[^\s"')]*/g, (m, host: string) => (/\d{6,}|[A-Za-z0-9_-]{20,}/.test(m.slice(host.length)) ? `${host}/…` : m))
    .replace(HEX_KEY, (m) => `${m.slice(0, 10)}…`);
}

export const firstLine = (e: unknown, max = 300): string => redact((e instanceof Error ? e.message : String(e)).split("\n")[0]).slice(0, max);
