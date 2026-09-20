/**
 * Defense-in-depth stripping of the most dangerous constructs from
 * untrusted email HTML before it's stored.
 *
 * IMPORTANT — this is NOT the security boundary. Regex/string-based HTML
 * "sanitizers" are well known to be bypassable (obfuscated attributes,
 * malformed tags that browsers still parse leniently, etc.), and there is
 * no DOM available in the Workers runtime to do this properly with a real
 * HTML parser. The actual security boundary is the sandboxed iframe the
 * frontend renders this content into:
 *   - `sandbox=""` (no allow-scripts, no allow-same-origin, no allow-forms,
 *     no allow-popups) — see EMAIL_VIEWER_IFRAME_SANDBOX in src/lib/security.ts
 *   - a strict Content-Security-Policy on that iframe's document
 *     — see EMAIL_VIEWER_IFRAME_CSP in src/lib/security.ts
 * Those two together make embedded `<script>`, inline event handlers, and
 * `javascript:` URLs *inert* regardless of whether this function catches
 * them. This function exists only to reduce the blast radius for any
 * consumer of the stored HTML that (by mistake or by design elsewhere)
 * doesn't go through the sandboxed viewer, and to strip the most obviously
 * hostile content before it's ever persisted.
 */
export function sanitizeEmailHtml(html: string): string {
  let result = html;

  // Remove <script>...</script> blocks entirely (including their content).
  result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  // Remove self-closing/void <script> tags with no matching close tag.
  result = result.replace(/<script\b[^>]*\/?>/gi, "");

  // Remove <style>...</style> blocks with url(javascript:...) or expression().
  result = result.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (block) =>
    /javascript:|expression\s*\(/i.test(block) ? "" : block
  );

  // Strip on*="..." / on*='...' / on*=bareword inline event handler attributes.
  result = result.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  result = result.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  result = result.replace(/\son\w+\s*=\s*[^\s>]+/gi, "");

  // Neutralize javascript: and data:text/html URLs in href/src/action/formaction.
  result = result.replace(
    /\s(href|src|action|formaction)\s*=\s*"(\s*javascript:|\s*data:text\/html)[^"]*"/gi,
    ' $1="about:blank"'
  );
  result = result.replace(
    /\s(href|src|action|formaction)\s*=\s*'(\s*javascript:|\s*data:text\/html)[^']*'/gi,
    " $1='about:blank'"
  );

  // Strip <meta http-equiv="refresh" ...> (can auto-navigate the viewer).
  result = result.replace(/<meta\s+[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");

  // Strip <base> tags, which could otherwise rewrite relative URL resolution
  // for the whole document in a way that aids phishing.
  result = result.replace(/<base\b[^>]*>/gi, "");

  return result;
}
