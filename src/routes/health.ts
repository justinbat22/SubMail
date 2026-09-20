import { Hono } from "hono";
import type { Env } from "../types/index.js";
import { ok } from "../lib/response.js";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/", () => {
  // Intentionally minimal: no DB/R2 credentials, bindings, or infra details.
  return ok({ status: "ok" });
});
