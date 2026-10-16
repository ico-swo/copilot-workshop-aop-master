import { Validator } from "../../core/validation.ts";

export const STOCK_REQUEST_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type StockRequestStatus = (typeof STOCK_REQUEST_STATUSES)[number];

/**
 * The allowed state transitions, as data. Served to the dashboard so it never
 * hard-codes which actions are available. Every decision is terminal.
 */
export const ALLOWED_TRANSITIONS: Record<StockRequestStatus, readonly StockRequestStatus[]> = {
  pending: ["approved", "rejected", "cancelled"],
  approved: [],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: StockRequestStatus, to: StockRequestStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export const MAX_REQUEST_QUANTITY = 500;

export interface StockRequest {
  id: string;
  reference: string;
  partId: string;
  part: { id: string; sku: string; name: string } | null;
  quantity: number;
  requestedBy: string;
  jobReference: string | null;
  status: StockRequestStatus;
  note: string | null;
  decidedBy: string | null;
  version: number;
  createdAt: string;
  decidedAt: string | null;
}

export interface CreateStockRequestInput {
  partId: string;
  quantity: number;
  /** Undefined means "the caller"; the service fills it from the actor. */
  requestedBy: string | undefined;
  jobReference: string | null;
  note: string | null;
}

const isBlank = (value: unknown) => value === null || value === "";

export function parseCreateStockRequest(input: unknown): CreateStockRequestInput {
  const v = Validator.forBody(input);
  v.rejectUnknown(["partId", "quantity", "requestedBy", "jobReference", "note"]);

  const partId = v.string("partId", { max: 64 });
  const quantity = v.integer("quantity", { min: 1, max: MAX_REQUEST_QUANTITY });
  const requestedBy = v.has("requestedBy") && !isBlank(v.raw("requestedBy")) ? v.string("requestedBy", { max: 120 }) : undefined;
  const jobReference = v.has("jobReference") && !isBlank(v.raw("jobReference")) ? v.string("jobReference", { max: 40 }) : null;
  const note = v.has("note") && !isBlank(v.raw("note")) ? v.string("note", { max: 240 }) : null;

  v.settle();
  return {
    partId: partId as string,
    quantity: quantity as number,
    requestedBy,
    jobReference: jobReference ?? null,
    note: note ?? null,
  };
}

/** Rejection requires a reason, recorded in the audit trail. */
export function parseRejection(input: unknown): string {
  const v = Validator.forBody(input);
  v.rejectUnknown(["reason"]);
  const reason = v.string("reason", { max: 240 });
  v.settle();
  return reason as string;
}
