-- Astra Parts Hub schema.
-- Applied on startup. Every statement is idempotent.

-- ---------------------------------------------------------------- suppliers
CREATE TABLE IF NOT EXISTS suppliers (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  contact_email  TEXT NOT NULL,
  phone          TEXT,
  country        TEXT NOT NULL,
  lead_time_days INTEGER NOT NULL CHECK (lead_time_days >= 0),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers (is_active);

-- -------------------------------------------------------------------- parts
CREATE TABLE IF NOT EXISTS parts (
  id             TEXT PRIMARY KEY,
  sku            TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL,
  vehicle_model  TEXT NOT NULL,
  unit_price_idr INTEGER NOT NULL CHECK (unit_price_idr >= 0),
  stock_quantity INTEGER NOT NULL CHECK (stock_quantity >= 0),
  reorder_level  INTEGER NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
  warehouse      TEXT NOT NULL,
  supplier_id    TEXT REFERENCES suppliers (id) ON DELETE RESTRICT,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_parts_category ON parts (category);
CREATE INDEX IF NOT EXISTS idx_parts_warehouse ON parts (warehouse);
CREATE INDEX IF NOT EXISTS idx_parts_supplier ON parts (supplier_id);

-- ---------------------------------------------------------- purchase orders
CREATE TABLE IF NOT EXISTS purchase_orders (
  id           TEXT PRIMARY KEY,
  reference    TEXT NOT NULL UNIQUE,
  supplier_id  TEXT NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  status       TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'approved', 'received', 'cancelled')),
  expected_at  TEXT,
  notes        TEXT,
  created_by   TEXT NOT NULL,
  approved_by  TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  submitted_at TEXT,
  approved_at  TEXT,
  received_at  TEXT,
  cancelled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders (status);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders (supplier_id);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id                TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  part_id           TEXT NOT NULL REFERENCES parts (id) ON DELETE RESTRICT,
  quantity          INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 10000),
  unit_price_idr    INTEGER NOT NULL CHECK (unit_price_idr >= 0),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  UNIQUE (purchase_order_id, part_id)
);

CREATE INDEX IF NOT EXISTS idx_po_lines_order ON purchase_order_lines (purchase_order_id);

-- ----------------------------------------------------------------- api keys
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

-- ------------------------------------------------------------- audit events
CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  request_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_events (occurred_at DESC);

-- ----------------------------------------------------------- stock requests
-- Technician draws parts from a warehouse; approval decrements stock.
-- See docs/spec-stock-requests.md.
CREATE TABLE IF NOT EXISTS stock_requests (
  id            TEXT PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,
  part_id       TEXT NOT NULL REFERENCES parts (id) ON DELETE RESTRICT,
  quantity      INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 500),
  requested_by  TEXT NOT NULL,
  job_reference TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  note          TEXT,
  decided_by    TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_stock_requests_status ON stock_requests (status);
CREATE INDEX IF NOT EXISTS idx_stock_requests_part ON stock_requests (part_id);
