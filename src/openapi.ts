import { config } from "./config.ts";
import { sendJson } from "./http/respond.ts";
import type { RouteDefinition } from "./http/router.ts";
import { CATEGORIES, ADJUSTMENT_REASONS } from "./modules/parts/schema.ts";
import { PO_STATUSES } from "./modules/purchase-orders/schema.ts";

/**
 * Hand-maintained OpenAPI description, served from the running process so it
 * can never describe a different version than the one deployed. When you add
 * an endpoint, add it here too.
 */
function document() {
  const listParams = [
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
    { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
    { name: "sort", in: "query", schema: { type: "string" } },
    { name: "direction", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
  ];
  const idParam = { name: "id", in: "path", required: true, schema: { type: "string" } };
  const ifMatch = { name: "If-Match", in: "header", description: "Entity tag for optimistic concurrency", schema: { type: "string", example: 'W/"3"' } };
  const ok = (description: string) => ({ "200": { description } });

  return {
    openapi: "3.1.0",
    info: {
      title: "Astra Parts Hub API",
      version: config.version,
      description: "Spare parts catalogue, supplier master data and procurement workflow for Astra Otoparts.",
    },
    servers: [{ url: "/", description: "This instance" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          tags: ["Service"],
          summary: "Service liveness and version (public)",
          security: [],
          responses: {
            "200": {
              description: "Service is running",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["status", "version", "uptimeSeconds"],
                    properties: {
                      status: { type: "string", enum: ["ok"] },
                      version: { type: "string", example: "1.0.0" },
                      uptimeSeconds: { type: "integer", minimum: 0, example: 42 },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/me": { get: { tags: ["Session"], summary: "Describe the caller and what they may do", responses: ok("Caller and capabilities") } },
      "/api/parts": {
        get: {
          tags: ["Parts"],
          summary: "List parts",
          parameters: [
            ...listParams,
            { name: "category", in: "query", schema: { type: "string", enum: CATEGORIES } },
            { name: "warehouse", in: "query", schema: { type: "string" } },
            { name: "supplierId", in: "query", schema: { type: "string" } },
            { name: "search", in: "query", schema: { type: "string" } },
            { name: "active", in: "query", schema: { type: "string", enum: ["true", "false"] } },
            { name: "belowReorder", in: "query", schema: { type: "string", enum: ["true"] } },
          ],
          responses: ok("A page of parts"),
        },
        post: { tags: ["Parts"], summary: "Create a part (operator)", responses: { "201": { description: "Created" }, "409": { description: "Duplicate SKU" } } },
      },
      "/api/parts/summary": { get: { tags: ["Parts"], summary: "Inventory totals", responses: ok("Totals") } },
      "/api/parts/reorder-list": { get: { tags: ["Parts"], summary: "Parts at or below reorder level", responses: ok("Reorder candidates") } },
      "/api/parts/options": { get: { tags: ["Parts"], summary: "Active parts and warehouses for form pickers", responses: ok("Options") } },
      "/api/parts/{id}": {
        get: { tags: ["Parts"], summary: "Get a part", parameters: [idParam], responses: ok("A part") },
        patch: { tags: ["Parts"], summary: "Update a part (stock excluded)", parameters: [idParam, ifMatch], responses: { "200": { description: "Updated" }, "412": { description: "Version conflict" } } },
        delete: { tags: ["Parts"], summary: "Delete a part (admin)", parameters: [idParam], responses: { "204": { description: "Deleted" }, "409": { description: "Part in use" } } },
      },
      "/api/parts/{id}/adjust-stock": {
        post: {
          tags: ["Parts"],
          summary: "Relative stock movement with a reason",
          description: `Reasons: ${ADJUSTMENT_REASONS.join(", ")}.`,
          parameters: [idParam],
          responses: { "200": { description: "New balance" }, "409": { description: "Insufficient stock" } },
        },
      },
      "/api/suppliers": {
        get: { tags: ["Suppliers"], summary: "List suppliers", parameters: listParams, responses: ok("A page of suppliers") },
        post: { tags: ["Suppliers"], summary: "Create a supplier (operator)", responses: { "201": { description: "Created" } } },
      },
      "/api/suppliers/options": { get: { tags: ["Suppliers"], summary: "Active suppliers for form pickers", responses: ok("Options") } },
      "/api/suppliers/{id}": {
        get: { tags: ["Suppliers"], summary: "Get a supplier", parameters: [idParam], responses: ok("A supplier") },
        patch: { tags: ["Suppliers"], summary: "Update a supplier", parameters: [idParam, ifMatch], responses: ok("Updated") },
        delete: { tags: ["Suppliers"], summary: "Delete a supplier (admin)", parameters: [idParam], responses: { "204": { description: "Deleted" }, "409": { description: "Supplier in use" } } },
      },
      "/api/purchase-orders": {
        get: {
          tags: ["Purchase orders"],
          summary: "List purchase orders",
          parameters: [...listParams, { name: "status", in: "query", schema: { type: "string", enum: PO_STATUSES } }],
          responses: ok("A page of orders"),
        },
        post: { tags: ["Purchase orders"], summary: "Raise a draft order", responses: { "201": { description: "Created" } } },
      },
      "/api/purchase-orders/transitions": { get: { tags: ["Purchase orders"], summary: "Allowed state transitions", responses: ok("Status map") } },
      "/api/purchase-orders/{id}": {
        get: { tags: ["Purchase orders"], summary: "Get an order with its lines", parameters: [idParam], responses: ok("An order") },
        patch: { tags: ["Purchase orders"], summary: "Edit a draft order", parameters: [idParam, ifMatch], responses: ok("Updated") },
      },
      "/api/purchase-orders/{id}/submit": { post: { tags: ["Purchase orders"], summary: "Submit for approval", parameters: [idParam, ifMatch], responses: ok("Submitted") } },
      "/api/purchase-orders/{id}/approve": {
        post: { tags: ["Purchase orders"], summary: "Approve (admin; not the raiser)", parameters: [idParam, ifMatch], responses: { "200": { description: "Approved" }, "403": { description: "Segregation of duties" } } },
      },
      "/api/purchase-orders/{id}/receive": { post: { tags: ["Purchase orders"], summary: "Goods receipt; increases stock transactionally", parameters: [idParam, ifMatch], responses: ok("Received") } },
      "/api/purchase-orders/{id}/cancel": { post: { tags: ["Purchase orders"], summary: "Cancel with a reason", parameters: [idParam, ifMatch], responses: ok("Cancelled") } },
      "/api/audit-events": { get: { tags: ["Audit"], summary: "Change history (operator)", parameters: listParams, responses: ok("A page of events") } },
      "/api/audit-events/{entityType}/{entityId}": { get: { tags: ["Audit"], summary: "History for one entity", responses: ok("Events") } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "An API key issued by the seed script" } },
    },
  };
}

export function openApiRoutes(): RouteDefinition[] {
  return [{ method: "GET", path: "/openapi.json", handler: (ctx) => sendJson(ctx.res, 200, document()) }];
}
