import type { ApiError, ApiErrorCode, ApiSuccess } from "../types/index.js";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  INVALID_REQUEST: 400,
  INVALID_MAILBOX: 400,
  MAILBOX_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  ATTACHMENT_NOT_FOUND: 404,
  NAME_UNAVAILABLE: 409,
  RESERVED_NAME: 409,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  DATABASE_ERROR: 500,
  STORAGE_ERROR: 500,
  PARSE_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export function ok<T>(data: T, init: ResponseInit = {}): Response {
  const body: ApiSuccess<T> = { success: true, data };
  return json(body, { status: 200, ...init });
}

export function created<T>(data: T, init: ResponseInit = {}): Response {
  const body: ApiSuccess<T> = { success: true, data };
  return json(body, { status: 201, ...init });
}

export function apiError(code: ApiErrorCode, message: string, init: ResponseInit = {}): Response {
  const body: ApiError = { success: false, error: { code, message } };
  const status = init.status ?? STATUS_BY_CODE[code];
  return json(body, { ...init, status });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}
