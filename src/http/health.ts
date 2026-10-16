import { config } from "../config.ts";
import { sendJson } from "./respond.ts";
import type { RouteDefinition } from "./router.ts";

/**
 * Liveness probe. Deliberately public and independent of the database, so it
 * still answers when storage is unavailable.
 */
export function healthRoutes(): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/health",
      handler: (ctx) =>
        sendJson(ctx.res, 200, { status: "ok", version: config.version, uptimeSeconds: Math.floor(process.uptime()) }),
    },
  ];
}
