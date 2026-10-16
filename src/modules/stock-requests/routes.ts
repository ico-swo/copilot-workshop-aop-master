import type { DatabaseSync } from "node:sqlite";
import type { RouteDefinition } from "../../http/router.ts";
import { sendJson, sendVersioned } from "../../http/respond.ts";
import type { AuditService } from "../audit/service.ts";
import { StockRequestService } from "./service.ts";
import { ALLOWED_TRANSITIONS, parseCreateStockRequest, parseRejection } from "./schema.ts";

export function stockRequestRoutes(db: DatabaseSync, audit: AuditService): RouteDefinition[] {
  const service = new StockRequestService(db, audit);
  const id = (params: Record<string, string>) => params["id"] as string;

  return [
    { method: "GET", path: "/api/stock-requests", requires: "viewer", handler: (ctx) => sendJson(ctx.res, 200, service.list(ctx.query)) },
    {
      // Static segment registered before /:id so it is not shadowed.
      method: "GET",
      path: "/api/stock-requests/transitions",
      requires: "viewer",
      handler: (ctx) => sendJson(ctx.res, 200, ALLOWED_TRANSITIONS),
    },
    {
      method: "GET",
      path: "/api/stock-requests/:id",
      requires: "viewer",
      handler: (ctx) => sendVersioned(ctx.res, 200, service.getById(id(ctx.params))),
    },
    {
      method: "POST",
      path: "/api/stock-requests",
      requires: "operator",
      handler: async (ctx) => {
        const input = parseCreateStockRequest(await ctx.readJsonBody());
        sendVersioned(ctx.res, 201, service.create(input, ctx.actor, ctx.requestId));
      },
    },
    {
      method: "POST",
      path: "/api/stock-requests/:id/approve",
      requires: "operator",
      handler: (ctx) => sendVersioned(ctx.res, 200, service.approve(id(ctx.params), ctx.ifMatchVersion(), ctx.actor, ctx.requestId)),
    },
    {
      method: "POST",
      path: "/api/stock-requests/:id/reject",
      requires: "operator",
      handler: async (ctx) => {
        const reason = parseRejection(await ctx.readJsonBody());
        sendVersioned(ctx.res, 200, service.reject(id(ctx.params), reason, ctx.ifMatchVersion(), ctx.actor, ctx.requestId));
      },
    },
    {
      method: "POST",
      path: "/api/stock-requests/:id/cancel",
      requires: "operator",
      handler: (ctx) => sendVersioned(ctx.res, 200, service.cancel(id(ctx.params), ctx.ifMatchVersion(), ctx.actor, ctx.requestId)),
    },
  ];
}
