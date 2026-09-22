/**
 * Safe JSON request-body parsing for endpoints where an absent/empty body is
 * a valid way to say "no fields provided", but anything else that isn't a
 * well-formed JSON object must be rejected outright.
 *
 * This exists because `body.json().catch(() => ({}))` — a pattern that
 * briefly existed in this codebase — is a real bug: it makes malformed JSON
 * indistinguishable from an intentionally empty request, silently turning
 * "this is not json" into "{}" and letting the request proceed as if the
 * client had sent nothing. That's wrong for any endpoint that changes state
 * (e.g. mailbox creation) — a client that got the body wrong should see a
 * 400, never a false "success".
 */

export type JsonObjectParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Parse a request body that is expected to be either absent/empty (treated
 * as `{}`) or a JSON object (`{...}`). Rejects:
 *  - malformed JSON (SyntaxError from JSON.parse)
 *  - a non-empty body sent with a Content-Type that isn't application/json
 *  - valid JSON that isn't a plain object: `null`, arrays, strings, numbers,
 *    booleans
 *
 * Never throws — every failure mode is returned as `{ ok: false, message }`
 * for the caller to turn into a structured 4xx response.
 */
export async function parseOptionalJsonObject(request: Request): Promise<JsonObjectParseResult> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, message: "Could not read request body." };
  }

  if (text.trim().length === 0) {
    // No body at all is valid for endpoints that treat this as "use
    // defaults" (e.g. auto-generated mailbox creation) — the caller decides
    // what an empty object means for its own endpoint.
    return { ok: true, value: {} };
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      message: "Content-Type must be application/json when sending a request body.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "Invalid JSON body." };
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}
