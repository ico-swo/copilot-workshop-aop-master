import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, body, type TestServer } from "./helpers.ts";

let server: TestServer;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.close();
});

interface Page<T> {
  items: T[];
  total: number;
  limit: number;
}

interface ErrorEnvelope {
  error: { code: string; message: string; details?: Record<string, string>; requestId?: string };
}

describe("authentication and authorisation", () => {
  test("rejects a request with no credentials", async () => {
    const response = await fetch(`${server.url}/api/parts`);
    assert.equal(response.status, 401);
  });

  test("rejects an unknown key", async () => {
    const response = await fetch(`${server.url}/api/parts`, { headers: { Authorization: "Bearer not-a-real-key" } });
    assert.equal(response.status, 401);
  });

  test("a viewer can read but cannot write", async () => {
    assert.equal((await server.request("/api/parts", { key: "viewer" })).status, 200);
    const write = await server.request("/api/parts", { key: "viewer", method: "POST", body: body({}) });
    assert.equal(write.status, 403);
  });

  test("an operator cannot perform an admin-only delete", async () => {
    const page = await server.json<Page<{ id: string }>>("/api/parts?limit=1");
    assert.equal((await server.request(`/api/parts/${page.items[0]?.id}`, { method: "DELETE" })).status, 403);
  });

  test("the audit trail is not readable by a viewer", async () => {
    assert.equal((await server.request("/api/audit-events", { key: "viewer" })).status, 403);
    assert.equal((await server.request("/api/audit-events")).status, 200);
  });
});

describe("session endpoint", () => {
  test("reports capabilities per role", async () => {
    const viewer = await server.json<{ can: Record<string, boolean> }>("/api/me", { key: "viewer" });
    const operator = await server.json<{ can: Record<string, boolean> }>("/api/me", { key: "operator" });
    const admin = await server.json<{ can: Record<string, boolean> }>("/api/me", { key: "admin" });
    assert.equal(viewer.can["write"], false);
    assert.equal(operator.can["write"], true);
    assert.equal(operator.can["approve"], false);
    assert.equal(admin.can["approve"], true);
    assert.equal(admin.can["delete"], true);
  });
});

describe("dashboard support endpoints", () => {
  test("supplier options exclude inactive suppliers", async () => {
    const options = await server.json<{ items: { code: string }[] }>("/api/suppliers/options");
    assert.ok(!options.items.some((s) => s.code === "SUP-LGCY"));
  });

  test("the state machine is served, so clients do not hard-code it", async () => {
    const transitions = await server.json<Record<string, string[]>>("/api/purchase-orders/transitions");
    assert.deepEqual(transitions["draft"], ["submitted", "cancelled"]);
  });

  test("static route segments are not shadowed by the :id route", async () => {
    for (const path of ["/api/parts/summary", "/api/parts/reorder-list", "/api/parts/options", "/api/suppliers/options"]) {
      assert.equal((await server.request(path)).status, 200, path);
    }
  });
});

describe("list endpoints", () => {
  test("returns a paginated envelope", async () => {
    const page = await server.json<Page<unknown>>("/api/parts?limit=3");
    assert.equal(page.items.length, 3);
    assert.equal(page.limit, 3);
  });

  test("rejects a sort field that is not on the allow-list", async () => {
    const response = await server.request("/api/parts?sort=stock_quantity;DROP TABLE parts");
    assert.equal(response.status, 400);
    assert.equal((await server.request("/api/parts?limit=1")).status, 200);
  });

  test("sorts on an allowed field in the requested direction", async () => {
    const page = await server.json<Page<{ unitPriceIdr: number }>>("/api/parts?sort=unitPriceIdr&direction=desc&limit=5");
    const prices = page.items.map((p) => p.unitPriceIdr);
    assert.deepEqual(prices, [...prices].sort((a, b) => b - a));
  });
});

describe("write flows over HTTP", () => {
  test("creates, edits and adjusts a part", async () => {
    const created = (await (
      await server.request("/api/parts", {
        method: "POST",
        body: body({ sku: "AOP-ENG-5150", name: "Thermostat housing", category: "engine", vehicleModel: "Xenia 1.3 R", unitPriceIdr: 275000, stockQuantity: 20, warehouse: "Jakarta-1" }),
      })
    ).json()) as { id: string; version: number };

    const edited = await server.request(`/api/parts/${created.id}`, {
      method: "PATCH",
      headers: { "If-Match": `W/"${created.version}"` },
      body: body({ unitPriceIdr: 289000 }),
    });
    assert.equal(edited.status, 200);

    const adjusted = await server.request(`/api/parts/${created.id}/adjust-stock`, {
      method: "POST",
      body: body({ delta: -5, reason: "damage" }),
    });
    assert.equal(((await adjusted.json()) as { stockQuantity: number }).stockQuantity, 15);
  });

  test("a stale If-Match is rejected with 412", async () => {
    const page = await server.json<Page<{ id: string }>>("/api/parts?search=AOP-BRK-1003");
    const id = page.items[0]?.id;
    const first = await server.request(`/api/parts/${id}`, { method: "PATCH", headers: { "If-Match": 'W/"1"' }, body: body({ name: "First writer" }) });
    assert.equal(first.status, 200);
    const second = await server.request(`/api/parts/${id}`, { method: "PATCH", headers: { "If-Match": 'W/"1"' }, body: body({ name: "Second writer" }) });
    assert.equal(second.status, 412);
  });

  test("runs an order from draft to received and moves stock", async () => {
    const suppliers = await server.json<{ items: { id: string; code: string }[] }>("/api/suppliers/options");
    const supplier = suppliers.items.find((s) => s.code === "SUP-NGKB");
    const part = (await server.json<Page<{ id: string; stockQuantity: number }>>("/api/parts?search=AOP-ELC-4003")).items[0];
    assert.ok(supplier && part);

    const created = (await (
      await server.request("/api/purchase-orders", {
        method: "POST",
        body: body({ supplierId: supplier.id, lines: [{ partId: part.id, quantity: 30, unitPriceIdr: 660000 }] }),
      })
    ).json()) as { id: string };

    assert.equal((await server.request(`/api/purchase-orders/${created.id}/submit`, { method: "POST" })).status, 200);
    assert.equal((await server.request(`/api/purchase-orders/${created.id}/approve`, { key: "admin", method: "POST" })).status, 200);
    assert.equal((await server.request(`/api/purchase-orders/${created.id}/receive`, { method: "POST", body: body({}) })).status, 200);

    const after = await server.json<{ stockQuantity: number }>(`/api/parts/${part.id}`);
    assert.equal(after.stockQuantity, part.stockQuantity + 30);
  });

  test("an invalid email comes back as a field-level detail the form can display", async () => {
    const response = await server.request("/api/suppliers", {
      method: "POST",
      body: body({ code: "SUP-BAD1", name: "Bad Email Co", contactEmail: "not-an-email", country: "Indonesia", leadTimeDays: 5 }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as ErrorEnvelope).error.details?.["contactEmail"], "must be a valid email address");
  });

  test("a supplier referenced by a part cannot be deleted", async () => {
    const suppliers = await server.json<Page<{ id: string }>>("/api/suppliers?search=Denso");
    const response = await server.request(`/api/suppliers/${suppliers.items[0]?.id}`, { key: "admin", method: "DELETE" });
    assert.equal(response.status, 409);
  });
});

describe("protocol behaviour", () => {
  test("unknown routes return a structured 404 carrying the request id", async () => {
    const response = await server.request("/api/unknown");
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as ErrorEnvelope).error.requestId, response.headers.get("x-request-id"));
  });

  test("an unsupported method on a known path returns 405", async () => {
    assert.equal((await server.request("/api/parts", { method: "DELETE" })).status, 405);
  });

  test("responses carry the baseline security headers", async () => {
    const response = await server.request("/api/parts?limit=1");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  });

  test("the dashboard assets are served without a key", async () => {
    for (const path of ["/", "/app.js", "/forms.js", "/api-client.js", "/styles.css", "/openapi.json"]) {
      assert.equal((await fetch(`${server.url}${path}`)).status, 200, path);
    }
  });

  test("GET /health reports service status", async () => {
    const response = await fetch(`${server.url}/health`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { status: string; version: string; uptimeSeconds: number };
    assert.equal(payload.status, "ok");
    assert.ok(payload.version.length > 0);
    assert.ok(Number.isInteger(payload.uptimeSeconds));
  });
});
