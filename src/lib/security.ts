/**
 * Baseline security headers applied to every response. CSP is deliberately
 * strict for the JSON API; the HTML frontend (added in a later phase) may
 * need a slightly different policy for its own document, but attachment and
 * message-viewing responses must never relax `frame-ancestors` or allow
 * inline script execution given they can carry attacker-controlled content.
 */
export function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
}

export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders())) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The Content-Security-Policy applied specifically to the sandboxed iframe
 * that renders untrusted incoming HTML email (see item 16 of the spec).
 * This is intentionally far stricter than a typical page CSP: no scripts,
 * no forms, no external frames, no plugins.
 */
export const EMAIL_VIEWER_IFRAME_CSP =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; " +
  "script-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'";

/**
 * The `sandbox` attribute value for the iframe that renders untrusted email
 * HTML. Deliberately omits `allow-scripts` and `allow-same-origin` — email
 * HTML must never execute script or access the parent document's origin.
 * `allow-popups` is also omitted to prevent click-driven navigation abuse.
 */
export const EMAIL_VIEWER_IFRAME_SANDBOX = "";
