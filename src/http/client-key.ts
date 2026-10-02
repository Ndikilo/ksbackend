/**
 * Rate-limit key from the `X-Forwarded-For` header.
 *
 * Proxies APPEND each hop, so the LEFTMOST entry is client-supplied and freely
 * spoofable; the LAST entry is the peer address observed by the nearest trusted
 * proxy (the platform edge), which a client cannot forge or strip. Keying on the
 * last hop means a rotating spoofed prefix cannot dodge the fixed window. No
 * usable header (direct connection, health probes, tests) → a shared "local"
 * bucket.
 */
export const clientKey = (forwardedFor: string | undefined): string => {
  const lastHop = forwardedFor?.split(",").at(-1)?.trim();
  return lastHop !== undefined && lastHop !== "" ? lastHop : "local";
};
