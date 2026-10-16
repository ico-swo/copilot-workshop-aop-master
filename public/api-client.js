/**
 * API client for the dashboard. Every call to the server goes through here,
 * so authentication, optimistic-concurrency headers and error translation
 * live in one place.
 */

/** An error carrying the server's structured payload. */
export class ApiError extends Error {
  constructor(status, payload, requestId) {
    super(payload?.error?.message ?? `Request failed with ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = payload?.error?.code ?? "unknown";
    /** Field-level problems keyed by field name. Drives inline form errors. */
    this.details = payload?.error?.details ?? {};
    this.requestId = requestId ?? payload?.error?.requestId;
  }
}

let apiKey = sessionStorage.getItem("aoph.key") ?? "";

export function setApiKey(value) {
  apiKey = value.trim();
  if (apiKey) sessionStorage.setItem("aoph.key", apiKey);
  else sessionStorage.removeItem("aoph.key");
}

export function getApiKey() {
  return apiKey;
}

async function send(method, path, { body, version } = {}) {
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Optimistic concurrency: the server answers 412 if the entity moved on.
  if (version !== undefined) headers["If-Match"] = `W/"${version}"`;

  const response = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, payload, response.headers.get("x-request-id"));
  return payload;
}

export const api = {
  me: () => send("GET", "/api/me"),

  parts: {
    list: (params) => send("GET", `/api/parts?${params}`),
    get: (id) => send("GET", `/api/parts/${id}`),
    create: (body) => send("POST", "/api/parts", { body }),
    update: (id, body, version) => send("PATCH", `/api/parts/${id}`, { body, version }),
    remove: (id) => send("DELETE", `/api/parts/${id}`),
    adjustStock: (id, body) => send("POST", `/api/parts/${id}/adjust-stock`, { body }),
    summary: () => send("GET", "/api/parts/summary"),
    options: () => send("GET", "/api/parts/options"),
  },

  suppliers: {
    list: (params) => send("GET", `/api/suppliers?${params}`),
    create: (body) => send("POST", "/api/suppliers", { body }),
    update: (id, body, version) => send("PATCH", `/api/suppliers/${id}`, { body, version }),
    remove: (id) => send("DELETE", `/api/suppliers/${id}`),
    options: () => send("GET", "/api/suppliers/options"),
  },

  orders: {
    list: (params) => send("GET", `/api/purchase-orders?${params}`),
    create: (body) => send("POST", "/api/purchase-orders", { body }),
    update: (id, body, version) => send("PATCH", `/api/purchase-orders/${id}`, { body, version }),
    transitions: () => send("GET", "/api/purchase-orders/transitions"),
    submit: (id, version) => send("POST", `/api/purchase-orders/${id}/submit`, { version }),
    approve: (id, version) => send("POST", `/api/purchase-orders/${id}/approve`, { version }),
    receive: (id, body, version) => send("POST", `/api/purchase-orders/${id}/receive`, { body, version }),
    cancel: (id, body, version) => send("POST", `/api/purchase-orders/${id}/cancel`, { body, version }),
  },

  stockRequests: {
    list: (params) => send("GET", `/api/stock-requests?${params}`),
    create: (body) => send("POST", "/api/stock-requests", { body }),
    transitions: () => send("GET", "/api/stock-requests/transitions"),
    approve: (id, version) => send("POST", `/api/stock-requests/${id}/approve`, { version }),
    reject: (id, body, version) => send("POST", `/api/stock-requests/${id}/reject`, { body, version }),
    cancel: (id, version) => send("POST", `/api/stock-requests/${id}/cancel`, { version }),
  },

  audit: {
    list: (params) => send("GET", `/api/audit-events?${params}`),
    forEntity: (type, id) => send("GET", `/api/audit-events/${type}/${id}`),
  },
};
