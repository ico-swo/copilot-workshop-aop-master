import type { DatabaseSync } from "node:sqlite";
import { createRouter, type RouteDefinition } from "./http/router.ts";
import { healthRoutes } from "./http/health.ts";
import { staticRoutes } from "./http/static.ts";
import { AuditService } from "./modules/audit/service.ts";
import { auditRoutes } from "./modules/audit/routes.ts";
import { AuthService } from "./modules/auth/service.ts";
import { authRoutes } from "./modules/auth/routes.ts";
import { partsRoutes } from "./modules/parts/routes.ts";
import { supplierRoutes } from "./modules/suppliers/routes.ts";
import { purchaseOrderRoutes } from "./modules/purchase-orders/routes.ts";
import { stockRequestRoutes } from "./modules/stock-requests/routes.ts";
import { openApiRoutes } from "./openapi.ts";

/**
 * Builds the request handler for a given database. Tests call this with an
 * in-memory database, so no test touches the real data file.
 */
export function createApp(db: DatabaseSync) {
  const audit = new AuditService(db);
  const auth = new AuthService(db);

  const routes: RouteDefinition[] = [
    ...partsRoutes(db, audit),
    ...supplierRoutes(db, audit),
    ...purchaseOrderRoutes(db, audit),
    ...stockRequestRoutes(db, audit),
    ...auditRoutes(audit),
    ...authRoutes(auth),
    ...openApiRoutes(),
    ...healthRoutes(),
    ...staticRoutes(),
  ];

  return createRouter(routes, {
    authenticate: auth.authenticate,
    authorize: auth.authorize,
    rateLimit: auth.rateLimit,
  });
}
