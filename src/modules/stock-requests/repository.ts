import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { WhereBuilder, enumFilter, page, parseListQuery, textFilter, type Page } from "../../core/query.ts";
import { STOCK_REQUEST_STATUSES, type StockRequest, type StockRequestStatus } from "./schema.ts";

interface StockRequestRow {
  id: string;
  reference: string;
  part_id: string;
  quantity: number;
  requested_by: string;
  job_reference: string | null;
  status: StockRequestStatus;
  note: string | null;
  decided_by: string | null;
  version: number;
  created_at: string;
  decided_at: string | null;
  part_sku: string | null;
  part_name: string | null;
}

function toStockRequest(row: StockRequestRow): StockRequest {
  return {
    id: row.id,
    reference: row.reference,
    partId: row.part_id,
    part: row.part_sku ? { id: row.part_id, sku: row.part_sku, name: row.part_name as string } : null,
    quantity: row.quantity,
    requestedBy: row.requested_by,
    jobReference: row.job_reference,
    status: row.status,
    note: row.note,
    decidedBy: row.decided_by,
    version: row.version,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

const SELECT = `
  SELECT r.*, p.sku AS part_sku, p.name AS part_name
    FROM stock_requests r LEFT JOIN parts p ON p.id = r.part_id`;

export interface NewStockRequest {
  partId: string;
  quantity: number;
  requestedBy: string;
  jobReference: string | null;
  note: string | null;
}

/** Outcome of an approval attempt, so the service can pick the right error. */
export type ApprovalResult =
  | { outcome: "approved"; request: StockRequest }
  | { outcome: "version_conflict" }
  | { outcome: "insufficient_stock" };

export class StockRequestRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Sequential per calendar year: SR-2026-0007. */
  #nextReference(): string {
    const year = new Date().getUTCFullYear();
    const row = this.#db
      .prepare("SELECT COUNT(*) AS count FROM stock_requests WHERE reference LIKE ?")
      .get(`SR-${year}-%`) as { count: number };
    return `SR-${year}-${String(row.count + 1).padStart(4, "0")}`;
  }

  list(params: URLSearchParams): Page<StockRequest> {
    const query = parseListQuery(params, {
      sortable: {
        reference: "r.reference",
        status: "r.status",
        quantity: "r.quantity",
        createdAt: "r.created_at",
        decidedAt: "r.decided_at",
      },
      defaultSort: "createdAt",
      filters: { status: enumFilter(STOCK_REQUEST_STATUSES), partId: textFilter(64) },
    });

    const where = new WhereBuilder()
      .addIf(query.filters["status"], "r.status = ?", query.filters["status"])
      .addIf(query.filters["partId"], "r.part_id = ?", query.filters["partId"]);

    const total = this.#db
      .prepare(`SELECT COUNT(*) AS count FROM stock_requests r ${where.sql}`)
      .get(...(where.values as never[])) as { count: number };

    const rows = this.#db
      .prepare(`${SELECT} ${where.sql} ORDER BY ${query.sort} ${query.direction === "asc" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`)
      .all(...([...where.values, query.limit, query.offset] as never[])) as unknown as StockRequestRow[];

    return page(rows.map(toStockRequest), total.count, query);
  }

  findById(id: string): StockRequest | undefined {
    const row = this.#db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as StockRequestRow | undefined;
    return row ? toStockRequest(row) : undefined;
  }

  /** Reference allocation and insert in one transaction, so references stay unique and sequential. */
  create(input: NewStockRequest): StockRequest {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT INTO stock_requests
             (id, reference, part_id, quantity, requested_by, job_reference, status, note, version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?)`,
        )
        .run(id, this.#nextReference(), input.partId, input.quantity, input.requestedBy, input.jobReference, input.note, now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return this.findById(id) as StockRequest;
  }

  /**
   * Moves a pending request to a terminal status without touching stock
   * (reject, cancel). Returns undefined when the version guard fails.
   */
  decide(id: string, to: "rejected" | "cancelled", expectedVersion: number, actorName: string): StockRequest | undefined {
    const now = new Date().toISOString();
    const result = this.#db
      .prepare(
        `UPDATE stock_requests SET status = ?, decided_by = ?, decided_at = ?, version = version + 1
          WHERE id = ? AND version = ? AND status = 'pending'`,
      )
      .run(to, actorName, now, id, expectedVersion);
    return result.changes > 0 ? this.findById(id) : undefined;
  }

  /**
   * Approves the request and decrements part stock in one transaction. The
   * stock guard re-checks availability at approval time: either both rows
   * change, or neither does.
   */
  approve(id: string, expectedVersion: number, actorName: string): ApprovalResult {
    const now = new Date().toISOString();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.#db
        .prepare(
          `UPDATE stock_requests SET status = 'approved', decided_by = ?, decided_at = ?, version = version + 1
            WHERE id = ? AND version = ? AND status = 'pending'
            RETURNING part_id, quantity`,
        )
        .get(actorName, now, id, expectedVersion) as { part_id: string; quantity: number } | undefined;

      if (!request) {
        this.#db.exec("ROLLBACK");
        return { outcome: "version_conflict" };
      }

      const stock = this.#db
        .prepare(
          `UPDATE parts SET stock_quantity = stock_quantity - ?, version = version + 1, updated_at = ?
            WHERE id = ? AND is_active = 1 AND stock_quantity >= ?`,
        )
        .run(request.quantity, now, request.part_id, request.quantity);

      if (stock.changes === 0) {
        this.#db.exec("ROLLBACK");
        return { outcome: "insufficient_stock" };
      }

      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { outcome: "approved", request: this.findById(id) as StockRequest };
  }
}
