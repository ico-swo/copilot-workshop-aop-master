/**
 * Warehouse dashboard. Plain ES modules, no build step.
 *
 * Two rules this file never breaks:
 *  1. Values from the API are written with textContent / createElement.
 *     Nothing is assigned to innerHTML.
 *  2. Validation is never duplicated here. The server rejects, and forms.js
 *     maps `error.details` back onto the inputs.
 */

import { api, ApiError, getApiKey, setApiKey } from "/api-client.js";
import { confirmAction, definitionList, element, openDrawer, openForm, sectionTitle } from "/forms.js";

/* ------------------------------------------------------------ formatting */

const idr = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
const compactIdr = new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const dateOnly = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" });

const el = (id) => document.getElementById(id);

const CATEGORIES = ["brake", "filter", "suspension", "electrical", "engine", "body"];
const ADJUSTMENT_REASONS = ["stock_take", "damage", "return", "correction"];
const NO_ACCESS = { role: "viewer", anonymous: true, can: { write: false, approve: false, delete: false, readAudit: false } };

/* ----------------------------------------------------------------- state */

const state = {
  view: "catalogue",
  limit: 10,
  offset: 0,
  filters: {},
  me: NO_ACCESS,
  suppliers: [],
  parts: [],
  warehouses: [],
  transitions: {},
  stockRequestTransitions: {},
};

function toast(message, kind = "info") {
  const node = el("toast");
  node.textContent = message;
  node.dataset.kind = kind;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 4500);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/* -------------------------------------------------------- reference data */

async function loadReferenceData() {
  const [suppliers, parts, transitions, stockRequestTransitions] = await Promise.allSettled([
    api.suppliers.options(),
    api.parts.options(),
    api.orders.transitions(),
    api.stockRequests.transitions(),
  ]);
  if (suppliers.status === "fulfilled") state.suppliers = suppliers.value.items;
  if (parts.status === "fulfilled") {
    state.parts = parts.value.items;
    state.warehouses = parts.value.warehouses;
  }
  if (transitions.status === "fulfilled") state.transitions = transitions.value;
  if (stockRequestTransitions.status === "fulfilled") state.stockRequestTransitions = stockRequestTransitions.value;
}

const supplierOptions = () => state.suppliers.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }));

/* ---------------------------------------------------------- field specs */

function partFields({ creating }) {
  return [
    {
      name: "sku",
      label: "SKU",
      placeholder: "AOP-BRK-1001",
      readonly: !creating,
      omit: !creating,
      hint: creating ? "Pattern AOP-XXX-0000" : "Cannot be changed after creation",
    },
    { name: "name", label: "Part name", wide: true },
    { name: "category", label: "Category", type: "select", options: CATEGORIES.map((c) => ({ value: c, label: c })) },
    { name: "vehicleModel", label: "Vehicle model" },
    { name: "unitPriceIdr", label: "Unit price (IDR)", type: "number", min: 0 },
    {
      name: "stockQuantity",
      label: creating ? "Opening stock" : "Stock",
      type: "number",
      min: 0,
      readonly: !creating,
      omit: !creating,
      hint: creating ? undefined : "Use Adjust stock to move the balance",
    },
    { name: "reorderLevel", label: "Reorder level", type: "number", min: 0 },
    {
      name: "warehouse",
      label: "Warehouse",
      type: "select",
      options: state.warehouses.map((w) => ({ value: w, label: w })),
      allowEmpty: true,
      emptyLabel: "— select —",
    },
    { name: "supplierId", label: "Supplier", type: "select", options: supplierOptions(), allowEmpty: true, nullable: true },
    { name: "isActive", label: "Active", type: "checkbox", default: true },
  ];
}

const supplierFields = ({ creating }) => [
  {
    name: "code",
    label: "Code",
    placeholder: "SUP-ABCD",
    readonly: !creating,
    omit: !creating,
    hint: creating ? "Pattern SUP-XXXX" : "Cannot be changed after creation",
  },
  { name: "name", label: "Supplier name", wide: true },
  { name: "contactEmail", label: "Contact email", type: "email" },
  { name: "phone", label: "Phone", nullable: true },
  { name: "country", label: "Country" },
  { name: "leadTimeDays", label: "Lead time (days)", type: "number", min: 0, max: 365 },
  { name: "isActive", label: "Active", type: "checkbox", default: true },
];

/* ----------------------------------------------------------- part actions */

function createPart() {
  openForm({
    title: "New part",
    fields: partFields({ creating: true }),
    values: { isActive: true, reorderLevel: 10, stockQuantity: 0 },
    submitLabel: "Create part",
    onSubmit: (payload) => api.parts.create(payload),
    onSuccess: async (created) => {
      toast(`Part ${created.sku} created`);
      await loadReferenceData();
      refresh();
    },
  });
}

function editPart(part) {
  openForm({
    title: `Edit ${part.sku}`,
    fields: partFields({ creating: false }),
    values: { ...part, supplierId: part.supplierId ?? "" },
    submitLabel: "Save changes",
    onSubmit: (payload) => api.parts.update(part.id, payload, part.version),
    onSuccess: async (updated) => {
      toast(`Part ${updated.sku} updated`);
      await loadReferenceData();
      refresh();
    },
  });
}

function adjustStock(part) {
  openForm({
    title: `Adjust stock — ${part.sku}`,
    submitLabel: "Apply adjustment",
    extra: () =>
      element("div", { class: "callout" }, [
        element("p", { text: `Current balance: ${part.stockQuantity} units (reorder at ${part.reorderLevel})` }),
        element("p", {
          class: "callout-muted",
          text: "Positive adds stock, negative removes it. The reason is recorded in the audit trail.",
        }),
      ]),
    fields: [
      { name: "delta", label: "Change", type: "number", hint: "For example 25 or -5" },
      { name: "reason", label: "Reason", type: "select", options: ADJUSTMENT_REASONS.map((r) => ({ value: r, label: r.replace("_", " ") })) },
      { name: "note", label: "Note", type: "textarea", wide: true, nullable: true, rows: 2 },
    ],
    onSubmit: (payload) => api.parts.adjustStock(part.id, payload),
    onSuccess: (updated) => {
      toast(`${part.sku} balance is now ${updated.stockQuantity}`);
      refresh();
    },
  });
}

function deletePart(part) {
  confirmAction({
    title: `Delete ${part.sku}?`,
    message: "This cannot be undone. It is refused if the part appears on any open purchase order.",
    confirmLabel: "Delete part",
    danger: true,
    onConfirm: async () => {
      await api.parts.remove(part.id);
      toast(`Part ${part.sku} deleted`);
      await loadReferenceData();
      refresh();
    },
  });
}

/* ------------------------------------------------------- supplier actions */

function createSupplier() {
  openForm({
    title: "New supplier",
    fields: supplierFields({ creating: true }),
    values: { isActive: true, leadTimeDays: 7, country: "Indonesia" },
    submitLabel: "Create supplier",
    onSubmit: (payload) => api.suppliers.create(payload),
    onSuccess: async (created) => {
      toast(`Supplier ${created.code} created`);
      await loadReferenceData();
      refresh();
    },
  });
}

function editSupplier(supplier) {
  openForm({
    title: `Edit ${supplier.code}`,
    fields: supplierFields({ creating: false }),
    values: supplier,
    submitLabel: "Save changes",
    onSubmit: (payload) => api.suppliers.update(supplier.id, payload, supplier.version),
    onSuccess: async (updated) => {
      toast(`Supplier ${updated.code} updated`);
      await loadReferenceData();
      refresh();
    },
  });
}

function deleteSupplier(supplier) {
  confirmAction({
    title: `Delete ${supplier.code}?`,
    message: "Suppliers referenced by a part or an order cannot be deleted. Deactivate them instead.",
    confirmLabel: "Delete supplier",
    danger: true,
    onConfirm: async () => {
      await api.suppliers.remove(supplier.id);
      toast(`Supplier ${supplier.code} deleted`);
      await loadReferenceData();
      refresh();
    },
  });
}

/* ---------------------------------------------------- purchase order forms */

/** Dynamic line-item editor used when raising an order. */
function lineEditor() {
  const rows = [];
  const list = element("div", { class: "line-list" });
  const totalNode = element("span", { class: "line-total-value", text: idr.format(0) });

  function recalculate() {
    const total = rows.reduce(
      (sum, row) => sum + (Number.parseInt(row.quantity.value, 10) || 0) * (Number.parseInt(row.price.value, 10) || 0),
      0,
    );
    totalNode.textContent = idr.format(total);
  }

  function addRow() {
    const select = element("select", { class: "line-part" });
    select.append(element("option", { value: "", text: "— select a part —" }));
    for (const part of state.parts) select.append(element("option", { value: part.id, text: `${part.sku} — ${part.name}` }));

    const quantity = element("input", { type: "number", min: "1", value: "1" });
    const price = element("input", { type: "number", min: "0", value: "0" });

    // Default the price to the catalogue price when a part is chosen.
    select.addEventListener("change", () => {
      const chosen = state.parts.find((part) => part.id === select.value);
      if (chosen && price.value === "0") price.value = String(chosen.unitPriceIdr);
      recalculate();
    });
    quantity.addEventListener("input", recalculate);
    price.addEventListener("input", recalculate);

    const row = { select, quantity, price, node: null };
    const remove = element("button", {
      type: "button",
      class: "icon-button",
      text: "✕",
      title: "Remove line",
      onClick: () => {
        rows.splice(rows.indexOf(row), 1);
        row.node.remove();
        recalculate();
      },
    });

    row.node = element("div", { class: "line-row" }, [select, quantity, price, remove]);
    list.append(row.node);
    rows.push(row);
    recalculate();
  }

  const node = element("div", { class: "line-editor" }, [
    sectionTitle("Order lines"),
    element("div", { class: "line-head" }, [
      element("span", { text: "Part" }),
      element("span", { text: "Qty" }),
      element("span", { text: "Unit price (IDR)" }),
      element("span", { text: "" }),
    ]),
    list,
    element("div", { class: "line-actions" }, [
      element("button", { type: "button", class: "button small", text: "+ Add line", onClick: addRow }),
      element("div", { class: "line-total" }, [element("span", { text: "Total" }), totalNode]),
    ]),
  ]);

  addRow();

  return {
    node,
    read: () =>
      rows
        .filter((row) => row.select.value)
        .map((row) => ({
          partId: row.select.value,
          quantity: Number.parseInt(row.quantity.value, 10) || 0,
          unitPriceIdr: Number.parseInt(row.price.value, 10) || 0,
        })),
  };
}

function createOrder() {
  const lines = lineEditor();
  openForm({
    title: "New purchase order",
    submitLabel: "Create draft",
    extra: () => lines.node,
    fields: [
      { name: "supplierId", label: "Supplier", type: "select", options: supplierOptions(), allowEmpty: true, emptyLabel: "— select a supplier —", wide: true },
      { name: "expectedAt", label: "Expected date", type: "date", nullable: true },
      { name: "notes", label: "Notes", type: "textarea", wide: true, nullable: true, rows: 2 },
    ],
    onSubmit: (payload) => api.orders.create({ ...payload, lines: lines.read() }),
    onSuccess: (created) => {
      toast(`${created.reference} created as a draft`);
      refresh();
    },
  });
}

function editOrder(order) {
  openForm({
    title: `Edit ${order.reference}`,
    submitLabel: "Save changes",
    extra: () =>
      element("div", { class: "callout" }, [
        element("p", { text: "Only a draft can be edited, and lines cannot be changed." }),
        element("p", { class: "callout-muted", text: "To change lines, cancel this order and raise a new one." }),
      ]),
    fields: [
      { name: "expectedAt", label: "Expected date", type: "date", nullable: true },
      { name: "notes", label: "Notes", type: "textarea", wide: true, nullable: true, rows: 3 },
    ],
    values: { expectedAt: order.expectedAt ?? "", notes: order.notes ?? "" },
    onSubmit: (payload) => api.orders.update(order.id, payload, order.version),
    onSuccess: (updated) => {
      toast(`${updated.reference} updated`);
      refresh();
    },
  });
}

/** Pre-filled with the ordered quantity, editable down for a partial delivery. */
function receiveOrder(order) {
  const inputs = new Map();
  const tbody = element("tbody");

  for (const line of order.lines) {
    const input = element("input", { type: "number", min: "0", max: String(line.quantity), value: String(line.quantity), class: "receive-qty" });
    inputs.set(line.partId, input);
    tbody.append(
      element("tr", {}, [
        element("td", {}, [element("strong", { text: line.partSku }), element("span", { class: "muted-inline", text: ` ${line.partName}` })]),
        element("td", { class: "numeric", text: String(line.quantity) }),
        element("td", { class: "numeric" }, [input]),
      ]),
    );
  }

  const table = element("table", { class: "receive-table" }, [
    element("thead", {}, [
      element("tr", {}, [
        element("th", { text: "Part" }),
        element("th", { text: "Ordered", class: "numeric" }),
        element("th", { text: "Receiving", class: "numeric" }),
      ]),
    ]),
    tbody,
  ]);

  openForm({
    title: `Receive ${order.reference}`,
    submitLabel: "Record receipt",
    fields: [],
    extra: () =>
      element("div", {}, [
        element("div", { class: "callout" }, [
          element("p", { text: "Receiving increases stock for every line, in one transaction." }),
          element("p", { class: "callout-muted", text: "Reduce a quantity for a partial delivery. You cannot receive more than was ordered." }),
        ]),
        table,
      ]),
    onSubmit: () =>
      api.orders.receive(
        order.id,
        { lines: [...inputs.entries()].map(([partId, input]) => ({ partId, receivedQuantity: Number.parseInt(input.value, 10) || 0 })) },
        order.version,
      ),
    onSuccess: async (received) => {
      toast(`${received.reference} received — stock updated`);
      await loadReferenceData();
      refresh();
    },
  });
}

function cancelOrder(order) {
  openForm({
    title: `Cancel ${order.reference}`,
    submitLabel: "Cancel order",
    fields: [{ name: "reason", label: "Reason", type: "textarea", wide: true, rows: 3, hint: "Recorded in the audit trail" }],
    onSubmit: (payload) => api.orders.cancel(order.id, payload, order.version),
    onSuccess: (cancelled) => {
      toast(`${cancelled.reference} cancelled`);
      refresh();
    },
  });
}

function transitionOrder(order, action, label) {
  confirmAction({
    title: `${label} ${order.reference}?`,
    message:
      action === "approve"
        ? "Approval is recorded against your key. You cannot approve an order you raised yourself."
        : "This moves the order to the next stage in the workflow.",
    confirmLabel: label,
    onConfirm: async () => {
      const updated = await api.orders[action](order.id, order.version);
      toast(`${updated.reference} is now ${updated.status}`);
      refresh();
    },
  });
}

/* ---------------------------------------------------- stock request actions */

function createStockRequest() {
  openForm({
    title: "New stock request",
    submitLabel: "Raise request",
    extra: () =>
      element("div", { class: "callout" }, [
        element("p", { text: "Stock is drawn only when an operator approves the request." }),
        element("p", { class: "callout-muted", text: "Leave Requested by empty to raise it in your own name." }),
      ]),
    fields: [
      {
        name: "partId",
        label: "Part",
        type: "select",
        wide: true,
        allowEmpty: true,
        emptyLabel: "— select a part —",
        options: state.parts.map((p) => ({ value: p.id, label: `${p.sku} — ${p.name} (${p.stockQuantity} in stock)` })),
      },
      { name: "quantity", label: "Quantity", type: "number" },
      { name: "requestedBy", label: "Requested by", nullable: true },
      { name: "jobReference", label: "Job reference", nullable: true },
      { name: "note", label: "Note", type: "textarea", wide: true, nullable: true, rows: 2 },
    ],
    onSubmit: (payload) => api.stockRequests.create(payload),
    onSuccess: (created) => {
      toast(`${created.reference} raised`);
      refresh();
    },
  });
}

function approveStockRequest(request) {
  confirmAction({
    title: `Approve ${request.reference}?`,
    message: `This draws ${request.quantity} unit(s) of ${request.part?.sku ?? "the part"} from stock. Availability is re-checked on approval.`,
    confirmLabel: "Approve",
    onConfirm: async () => {
      const updated = await api.stockRequests.approve(request.id, request.version);
      toast(`${updated.reference} approved — stock updated`);
      await loadReferenceData();
      refresh();
    },
  });
}

function rejectStockRequest(request) {
  openForm({
    title: `Reject ${request.reference}`,
    submitLabel: "Reject request",
    fields: [{ name: "reason", label: "Reason", type: "textarea", wide: true, rows: 3, hint: "Recorded in the audit trail" }],
    onSubmit: (payload) => api.stockRequests.reject(request.id, payload, request.version),
    onSuccess: (rejected) => {
      toast(`${rejected.reference} rejected`);
      refresh();
    },
  });
}

function cancelStockRequest(request) {
  confirmAction({
    title: `Cancel ${request.reference}?`,
    message: "Only the person who requested it may cancel it.",
    confirmLabel: "Cancel request",
    danger: true,
    onConfirm: async () => {
      const cancelled = await api.stockRequests.cancel(request.id, request.version);
      toast(`${cancelled.reference} cancelled`);
      refresh();
    },
  });
}

/** Write actions allowed by the served state machine and the caller's capabilities. */
function stockRequestActions(request) {
  const allowed = state.stockRequestTransitions[request.status] ?? [];
  return [
    state.me.can.write && allowed.includes("approved") && { label: "Approve", variant: "primary", onClick: () => approveStockRequest(request) },
    state.me.can.write && allowed.includes("rejected") && { label: "Reject", onClick: () => rejectStockRequest(request) },
    state.me.can.write && allowed.includes("cancelled") && { label: "Cancel", variant: "danger", onClick: () => cancelStockRequest(request) },
  ];
}

/* ---------------------------------------------------------- detail drawers */

async function historyFor(entityType, entityId) {
  if (!state.me.can.readAudit) return null;
  try {
    const { items } = await api.audit.forEntity(entityType, entityId);
    if (items.length === 0) return null;

    const list = element("ul", { class: "history" });
    for (const event of items) {
      list.append(
        element("li", {}, [
          element("span", { class: "history-when", text: dateTime.format(new Date(event.occurredAt)) }),
          element("span", { class: "badge", dataset: { value: event.action }, text: event.action.replace(/\./g, " · ") }),
          element("span", { class: "history-summary", text: event.summary }),
          element("span", { class: "history-actor", text: event.actor }),
        ]),
      );
    }
    return element("div", {}, [sectionTitle("History"), list]);
  } catch {
    return null;
  }
}

async function showPart(part) {
  openDrawer({
    title: `${part.sku} — ${part.name}`,
    subtitle: part.belowReorderLevel ? "At or below reorder level" : "Stock is healthy",
    sections: [
      definitionList([
        ["Category", part.category],
        ["Vehicle model", part.vehicleModel],
        ["Warehouse", part.warehouse],
        ["Supplier", part.supplier ? `${part.supplier.code} — ${part.supplier.name}` : "Not assigned"],
        ["Lead time", part.supplier ? `${part.supplier.leadTimeDays} days` : null],
        ["Unit price", idr.format(part.unitPriceIdr)],
        ["Stock on hand", `${part.stockQuantity} units`],
        ["Reorder level", `${part.reorderLevel} units`],
        ["Stock value", idr.format(part.unitPriceIdr * part.stockQuantity)],
        ["Status", part.isActive ? "Active" : "Inactive"],
        ["Version", part.version],
        ["Last updated", dateTime.format(new Date(part.updatedAt))],
      ]),
      await historyFor("part", part.id),
    ],
    actions: [
      state.me.can.write && { label: "Edit", onClick: () => editPart(part) },
      state.me.can.write && { label: "Adjust stock", variant: "primary", onClick: () => adjustStock(part) },
      state.me.can.delete && { label: "Delete", variant: "danger", onClick: () => deletePart(part) },
    ],
  });
}

async function showSupplier(supplier) {
  openDrawer({
    title: `${supplier.code} — ${supplier.name}`,
    subtitle: supplier.isActive ? "Active supplier" : "Inactive supplier",
    sections: [
      definitionList([
        ["Country", supplier.country],
        ["Contact email", supplier.contactEmail],
        ["Phone", supplier.phone ?? "Not recorded"],
        ["Lead time", `${supplier.leadTimeDays} days`],
        ["Version", supplier.version],
        ["Last updated", dateTime.format(new Date(supplier.updatedAt))],
      ]),
      await historyFor("supplier", supplier.id),
    ],
    actions: [
      state.me.can.write && { label: "Edit", variant: "primary", onClick: () => editSupplier(supplier) },
      state.me.can.delete && { label: "Delete", variant: "danger", onClick: () => deleteSupplier(supplier) },
    ],
  });
}

async function showOrder(order) {
  const allowed = state.transitions[order.status] ?? [];
  const tbody = element("tbody");

  for (const line of order.lines) {
    tbody.append(
      element("tr", {}, [
        element("td", {}, [element("strong", { text: line.partSku }), element("span", { class: "muted-inline", text: ` ${line.partName}` })]),
        element("td", { class: "numeric", text: String(line.quantity) }),
        element("td", { class: "numeric", text: String(line.receivedQuantity) }),
        element("td", { class: "numeric", text: idr.format(line.unitPriceIdr) }),
        element("td", { class: "numeric", text: idr.format(line.lineTotalIdr) }),
      ]),
    );
  }
  tbody.append(
    element("tr", { class: "total-row" }, [
      element("td", { text: "Total" }),
      element("td"),
      element("td"),
      element("td"),
      element("td", { class: "numeric", text: idr.format(order.totalIdr) }),
    ]),
  );

  const table = element("table", { class: "line-table" }, [
    element("thead", {}, [
      element("tr", {}, [
        element("th", { text: "Part" }),
        element("th", { text: "Qty", class: "numeric" }),
        element("th", { text: "Received", class: "numeric" }),
        element("th", { text: "Unit price", class: "numeric" }),
        element("th", { text: "Line total", class: "numeric" }),
      ]),
    ]),
    tbody,
  ]);

  openDrawer({
    title: order.reference,
    subtitle: `${order.status} · ${order.supplier?.name ?? "Unknown supplier"}`,
    sections: [
      definitionList([
        ["Supplier", order.supplier ? `${order.supplier.code} — ${order.supplier.name}` : "Unknown"],
        ["Status", order.status],
        ["Raised by", order.createdBy],
        ["Approved by", order.approvedBy ?? "Not approved"],
        ["Expected", order.expectedAt ? dateOnly.format(new Date(order.expectedAt)) : "Not set"],
        ["Notes", order.notes ?? "None"],
        ["Created", dateTime.format(new Date(order.createdAt))],
        ["Received", order.receivedAt ? dateTime.format(new Date(order.receivedAt)) : null],
        ["Cancelled", order.cancelledAt ? dateTime.format(new Date(order.cancelledAt)) : null],
        ["Version", order.version],
      ]),
      element("div", {}, [sectionTitle("Lines"), table]),
      await historyFor("purchase_order", order.id),
    ],
    actions: [
      state.me.can.write && order.status === "draft" && { label: "Edit", onClick: () => editOrder(order) },
      state.me.can.write && allowed.includes("submitted") && { label: "Submit", variant: "primary", onClick: () => transitionOrder(order, "submit", "Submit") },
      allowed.includes("approved") && {
        label: "Approve",
        variant: "primary",
        disabled: !state.me.can.approve,
        title: state.me.can.approve ? "" : "Requires the admin role",
        onClick: () => transitionOrder(order, "approve", "Approve"),
      },
      state.me.can.write && allowed.includes("received") && { label: "Receive goods", variant: "primary", onClick: () => receiveOrder(order) },
      state.me.can.write && allowed.includes("cancelled") && { label: "Cancel order", variant: "danger", onClick: () => cancelOrder(order) },
    ],
  });
}

/* ----------------------------------------------------------- view configs */

async function showStockRequest(request) {
  openDrawer({
    title: request.reference,
    subtitle: `${request.status} · ${request.part ? `${request.part.sku} — ${request.part.name}` : "Unknown part"}`,
    sections: [
      definitionList([
        ["Part", request.part ? `${request.part.sku} — ${request.part.name}` : "Unknown"],
        ["Quantity", `${request.quantity} units`],
        ["Status", request.status],
        ["Requested by", request.requestedBy],
        ["Job reference", request.jobReference ?? "None"],
        ["Note", request.note ?? "None"],
        ["Decided by", request.decidedBy ?? "Pending"],
        ["Decided", request.decidedAt ? dateTime.format(new Date(request.decidedAt)) : null],
        ["Created", dateTime.format(new Date(request.createdAt))],
        ["Version", request.version],
      ]),
      await historyFor("stock_request", request.id),
    ],
    actions: stockRequestActions(request),
  });
}

const activeFilter = {
  type: "select",
  key: "active",
  label: "Active and inactive",
  options: () => [
    { value: "true", label: "Active only" },
    { value: "false", label: "Inactive only" },
  ],
};

const VIEWS = {
  catalogue: {
    title: "Catalogue",
    fetch: (params) => api.parts.list(params),
    onRowClick: showPart,
    create: { label: "New part", run: createPart },
    columns: [
      { label: "SKU", render: (row) => row.sku },
      { label: "Part", render: (row) => row.name },
      { label: "Category", render: (row) => row.category, badge: true },
      { label: "Supplier", render: (row) => row.supplier?.code ?? "—" },
      { label: "Warehouse", render: (row) => row.warehouse },
      { label: "Unit price", numeric: true, render: (row) => idr.format(row.unitPriceIdr) },
      {
        label: "Stock",
        numeric: true,
        render: (row) => `${row.stockQuantity} / ${row.reorderLevel}`,
        className: (row) => (row.belowReorderLevel ? "low" : ""),
      },
    ],
    rowActions: (row) => [
      state.me.can.write && { label: "Edit", onClick: () => editPart(row) },
      state.me.can.write && { label: "Stock", onClick: () => adjustStock(row) },
      state.me.can.delete && { label: "Delete", variant: "danger", onClick: () => deletePart(row) },
    ],
    controls: [
      { type: "search", key: "search", placeholder: "Search by name or SKU" },
      { type: "select", key: "category", label: "All categories", options: () => CATEGORIES },
      { type: "select", key: "warehouse", label: "All warehouses", options: () => state.warehouses },
      activeFilter,
    ],
  },

  reorder: {
    title: "Parts at or below reorder level",
    fetch: (params) => {
      const scoped = new URLSearchParams(params);
      scoped.set("belowReorder", "true");
      scoped.set("active", "true");
      scoped.set("sort", "stockQuantity");
      scoped.set("direction", "asc");
      return api.parts.list(scoped);
    },
    onRowClick: showPart,
    columns: [
      { label: "SKU", render: (row) => row.sku },
      { label: "Part", render: (row) => row.name },
      { label: "Supplier", render: (row) => row.supplier?.code ?? "—" },
      { label: "Lead time", render: (row) => (row.supplier ? `${row.supplier.leadTimeDays} days` : "—") },
      { label: "Warehouse", render: (row) => row.warehouse },
      { label: "On hand", numeric: true, render: (row) => String(row.stockQuantity), className: () => "low" },
      { label: "Reorder at", numeric: true, render: (row) => String(row.reorderLevel) },
      { label: "Shortfall", numeric: true, render: (row) => String(Math.max(row.reorderLevel - row.stockQuantity, 0)) },
    ],
    rowActions: (row) => [state.me.can.write && { label: "Stock", onClick: () => adjustStock(row) }],
    controls: [],
  },

  orders: {
    title: "Purchase orders",
    fetch: (params) => {
      const scoped = new URLSearchParams(params);
      scoped.set("sort", "createdAt");
      scoped.set("direction", "desc");
      return api.orders.list(scoped);
    },
    onRowClick: showOrder,
    create: { label: "New order", run: createOrder },
    columns: [
      { label: "Reference", render: (row) => row.reference },
      { label: "Supplier", render: (row) => row.supplier?.name ?? "—" },
      { label: "Status", render: (row) => row.status, badge: true },
      { label: "Lines", numeric: true, render: (row) => String(row.lines.length) },
      { label: "Total", numeric: true, render: (row) => idr.format(row.totalIdr) },
      { label: "Raised by", render: (row) => row.createdBy },
      { label: "Created", render: (row) => dateTime.format(new Date(row.createdAt)) },
    ],
    rowActions: (row) => {
      const allowed = state.transitions[row.status] ?? [];
      return [
        state.me.can.write && allowed.includes("submitted") && { label: "Submit", onClick: () => transitionOrder(row, "submit", "Submit") },
        state.me.can.approve && allowed.includes("approved") && { label: "Approve", onClick: () => transitionOrder(row, "approve", "Approve") },
        state.me.can.write && allowed.includes("received") && { label: "Receive", onClick: () => receiveOrder(row) },
      ];
    },
    controls: [
      { type: "select", key: "status", label: "All statuses", options: () => ["draft", "submitted", "approved", "received", "cancelled"] },
      { type: "select", key: "supplierId", label: "All suppliers", options: () => state.suppliers.map((s) => ({ value: s.id, label: s.code })) },
    ],
  },

  suppliers: {
    title: "Suppliers",
    fetch: (params) => api.suppliers.list(params),
    onRowClick: showSupplier,
    create: { label: "New supplier", run: createSupplier },
    columns: [
      { label: "Code", render: (row) => row.code },
      { label: "Name", render: (row) => row.name },
      { label: "Country", render: (row) => row.country },
      { label: "Contact", render: (row) => row.contactEmail },
      { label: "Lead time", numeric: true, render: (row) => `${row.leadTimeDays} days` },
      { label: "Status", badge: true, render: (row) => (row.isActive ? "active" : "inactive") },
    ],
    rowActions: (row) => [
      state.me.can.write && { label: "Edit", onClick: () => editSupplier(row) },
      state.me.can.delete && { label: "Delete", variant: "danger", onClick: () => deleteSupplier(row) },
    ],
    controls: [{ type: "search", key: "search", placeholder: "Search by name or code" }, activeFilter],
  },

  audit: {
    title: "Audit trail",
    fetch: (params) => {
      const scoped = new URLSearchParams(params);
      scoped.set("sort", "occurredAt");
      scoped.set("direction", "desc");
      return api.audit.list(scoped);
    },
    columns: [
      { label: "When", render: (row) => dateTime.format(new Date(row.occurredAt)) },
      { label: "Actor", render: (row) => row.actor },
      { label: "Action", badge: true, render: (row) => row.action },
      { label: "Entity", render: (row) => row.entityType },
      { label: "Summary", wide: true, render: (row) => row.summary },
    ],
    controls: [{ type: "select", key: "entityType", label: "All entities", options: () => ["part", "supplier", "purchase_order", "stock_request"] }],
  },

  stockRequests: {
    title: "Stock requests",
    fetch: (params) => {
      const scoped = new URLSearchParams(params);
      scoped.set("sort", "createdAt");
      scoped.set("direction", "desc");
      return api.stockRequests.list(scoped);
    },
    onRowClick: showStockRequest,
    create: { label: "New request", run: createStockRequest },
    columns: [
      { label: "Reference", render: (row) => row.reference },
      { label: "Part", render: (row) => (row.part ? `${row.part.sku} — ${row.part.name}` : "—") },
      { label: "Qty", numeric: true, render: (row) => String(row.quantity) },
      { label: "Status", badge: true, render: (row) => row.status },
      { label: "Requested by", render: (row) => row.requestedBy },
      { label: "Job", render: (row) => row.jobReference },
      { label: "Created", render: (row) => dateTime.format(new Date(row.createdAt)) },
    ],
    rowActions: stockRequestActions,
    controls: [
      { type: "select", key: "status", label: "All statuses", options: () => Object.keys(state.stockRequestTransitions) },
      { type: "select", key: "partId", label: "All parts", options: () => state.parts.map((p) => ({ value: p.id, label: p.sku })) },
    ],
  },
};

/* ------------------------------------------------------------- rendering */

function listParams() {
  const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
  for (const [key, value] of Object.entries(state.filters)) if (value) params.set(key, value);
  return params;
}

function renderControls(view) {
  const host = el("controls");
  host.replaceChildren();

  for (const control of view.controls) {
    if (control.type === "search") {
      host.append(
        element("input", {
          type: "search",
          placeholder: control.placeholder,
          "aria-label": control.placeholder,
          value: state.filters[control.key] ?? "",
          onInput: debounce((event) => {
            state.filters[control.key] = event.target.value.trim();
            state.offset = 0;
            loadTable();
          }, 250),
        }),
      );
      continue;
    }

    const select = element("select", { "aria-label": control.label });
    select.append(element("option", { value: "", text: control.label }));
    for (const option of control.options()) {
      const value = typeof option === "string" ? option : option.value;
      const label = typeof option === "string" ? option.replace(/_/g, " ") : option.label;
      select.append(element("option", { value, text: label }));
    }
    select.value = state.filters[control.key] ?? "";
    select.addEventListener("change", (event) => {
      state.filters[control.key] = event.target.value;
      state.offset = 0;
      loadTable();
    });
    host.append(select);
  }

  const action = el("panel-action");
  action.replaceChildren();
  if (view.create && state.me.can.write) {
    action.append(element("button", { class: "button primary", text: `+ ${view.create.label}`, onClick: view.create.run }));
  }
}

function renderHead(view) {
  const row = element("tr");
  for (const column of view.columns) row.append(element("th", { scope: "col", text: column.label, class: column.numeric ? "numeric" : "" }));
  if (view.rowActions) row.append(element("th", { scope: "col", class: "actions-column" }));
  el("table-head").replaceChildren(row);
}

const emptyRow = (span, message) => element("tr", {}, [element("td", { colSpan: span, class: "empty", text: message })]);

function renderRows(view, items) {
  const body = el("table-body");
  const span = view.columns.length + (view.rowActions ? 1 : 0);
  body.replaceChildren();

  if (items.length === 0) {
    body.append(emptyRow(span, "Nothing matches the current filters"));
    return;
  }

  for (const item of items) {
    const row = element("tr", { class: view.onRowClick ? "clickable" : "" });

    for (const column of view.columns) {
      const value = column.render(item);
      const cell = element("td", { class: column.numeric ? "numeric" : "" });
      if (column.badge) {
        cell.append(element("span", { class: "badge", dataset: { value: String(value) }, text: String(value).replace(/[_.]/g, " ") }));
      } else {
        cell.textContent = value === null || value === undefined ? "—" : String(value);
      }
      if (column.wide) cell.classList.add("wide");
      const extra = column.className?.(item);
      if (extra) cell.classList.add(extra);
      row.append(cell);
    }

    if (view.rowActions) {
      const cell = element("td", { class: "row-actions" });
      for (const action of (view.rowActions(item) ?? []).filter(Boolean)) {
        cell.append(
          element("button", {
            class: `button small ${action.variant ?? ""}`,
            text: action.label,
            onClick: (event) => {
              event.stopPropagation();
              action.onClick();
            },
          }),
        );
      }
      row.append(cell);
    }

    if (view.onRowClick) row.addEventListener("click", () => view.onRowClick(item));
    body.append(row);
  }
}

async function loadTable() {
  const view = VIEWS[state.view];
  el("panel-title").textContent = view.title;
  renderHead(view);

  try {
    const data = await view.fetch(listParams());
    renderRows(view, data.items);
    const from = data.total === 0 ? 0 : state.offset + 1;
    const to = Math.min(state.offset + state.limit, data.total);
    el("page-info").textContent = `${from}–${to} of ${data.total}`;
    el("prev").disabled = state.offset === 0;
    el("next").disabled = to >= data.total;
  } catch (error) {
    const span = view.columns.length + (view.rowActions ? 1 : 0);
    const hint =
      error.status === 401
        ? "Enter a valid API key above to load this view."
        : error.status === 403
          ? `Your key does not have permission for ${view.title.toLowerCase()}.`
          : error.message;
    el("table-body").replaceChildren(emptyRow(span, hint));
    el("page-info").textContent = "—";
    el("prev").disabled = true;
    el("next").disabled = true;
  }
}

async function loadMetrics() {
  const ids = ["metric-total", "metric-reorder", "metric-value", "metric-open-orders", "metric-warehouses"];
  try {
    const [summary, open] = await Promise.all([
      api.parts.summary(),
      api.orders.list(new URLSearchParams({ limit: "1", status: "submitted" })),
    ]);
    el("metric-total").textContent = String(summary.totalParts);
    el("metric-reorder").textContent = String(summary.belowReorder);
    el("metric-value").textContent = `Rp ${compactIdr.format(summary.stockValueIdr)}`;
    el("metric-open-orders").textContent = String(open.total);
    el("metric-warehouses").textContent = String(summary.warehouses);
  } catch {
    for (const id of ids) el(id).textContent = "—";
  }
}

async function loadSession() {
  const badge = el("role-badge");
  try {
    state.me = await api.me();
    badge.textContent = state.me.anonymous ? "anonymous · read only" : `${state.me.name} · ${state.me.role}`;
    badge.dataset.role = state.me.role;
    badge.dataset.readonly = String(!state.me.can.write);
  } catch (error) {
    state.me = NO_ACCESS;
    badge.textContent = error instanceof ApiError && error.status === 401 ? "no key · enter one to sign in" : "unknown";
    badge.dataset.role = "none";
    badge.dataset.readonly = "true";
  }
}

async function checkHealth() {
  const status = el("service-status");
  try {
    // Lab 1 introduces /health.
    const response = await fetch("/health");
    if (!response.ok) throw new Error("unavailable");
    const payload = await response.json();
    status.textContent = `Healthy · v${payload.version}`;
    status.dataset.state = "ok";
  } catch {
    status.textContent = "Health endpoint not implemented";
    status.dataset.state = "warn";
  }
}

/** Reloads everything that could have changed after a write. */
async function refresh() {
  await Promise.allSettled([loadTable(), loadMetrics()]);
}

/* ---------------------------------------------------------------- wiring */

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".tab")) other.setAttribute("aria-selected", String(other === tab));
    state.view = tab.dataset.view;
    state.offset = 0;
    state.filters = {};
    renderControls(VIEWS[state.view]);
    loadTable();
  });
}

el("prev").addEventListener("click", () => {
  state.offset = Math.max(0, state.offset - state.limit);
  loadTable();
});

el("next").addEventListener("click", () => {
  state.offset += state.limit;
  loadTable();
});

const keyInput = el("api-key");
keyInput.value = getApiKey();
keyInput.addEventListener(
  "input",
  debounce(async (event) => {
    setApiKey(event.target.value);
    await loadSession();
    await loadReferenceData();
    renderControls(VIEWS[state.view]);
    await refresh();
    toast(state.me.can.write ? `Signed in as ${state.me.name}` : "Read-only access", "info");
  }, 400),
);

await loadSession();
await loadReferenceData();
renderControls(VIEWS[state.view]);
await Promise.allSettled([loadTable(), loadMetrics(), checkHealth()]);
