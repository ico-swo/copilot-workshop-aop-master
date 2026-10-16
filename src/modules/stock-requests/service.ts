import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../../core/errors.ts";
import type { Page } from "../../core/query.ts";
import type { AuditService } from "../audit/service.ts";
import type { Actor } from "../auth/types.ts";
import { PartsRepository } from "../parts/repository.ts";
import { StockRequestRepository } from "./repository.ts";
import { canTransition, type CreateStockRequestInput, type StockRequest, type StockRequestStatus } from "./schema.ts";

/**
 * Stock request workflow: pending -> approved | rejected | cancelled.
 * Approval is the only operation that changes stock, and it decrements it in
 * the same transaction as the status change.
 */
export class StockRequestService {
  readonly #repository: StockRequestRepository;
  readonly #parts: PartsRepository;
  readonly #audit: AuditService;

  constructor(db: DatabaseSync, audit: AuditService) {
    this.#repository = new StockRequestRepository(db);
    this.#parts = new PartsRepository(db);
    this.#audit = audit;
  }

  list(params: URLSearchParams): Page<StockRequest> {
    return this.#repository.list(params);
  }

  getById(id: string): StockRequest {
    const request = this.#repository.findById(id);
    if (!request) throw AppError.notFound("Stock request", id);
    return request;
  }

  create(input: CreateStockRequestInput, actor: Actor, requestId: string): StockRequest {
    const part = this.#parts.findById(input.partId);
    if (!part) {
      throw AppError.badRequest("The request body failed validation", { partId: `no part exists with id '${input.partId}'` });
    }
    if (!part.isActive) {
      throw AppError.badRequest("The request body failed validation", { partId: `part '${part.sku}' is inactive` });
    }
    if (input.quantity > part.stockQuantity) {
      throw AppError.conflict(
        "insufficient_stock",
        `Requested ${input.quantity} of '${part.sku}' but only ${part.stockQuantity} in stock`,
      );
    }

    const created = this.#repository.create({
      partId: part.id,
      quantity: input.quantity,
      requestedBy: input.requestedBy ?? actor.name,
      jobReference: input.jobReference,
      note: input.note,
    });

    this.#audit.record({
      actor: actor.name,
      action: "stock_request.created",
      entityType: "stock_request",
      entityId: created.id,
      summary: `Raised ${created.reference} for ${created.quantity} x ${part.sku} on behalf of ${created.requestedBy}`,
      requestId,
    });
    return created;
  }

  /** Guards shared by every decision: terminal states cannot be decided again. */
  #pendingFor(id: string, to: StockRequestStatus): StockRequest {
    const current = this.getById(id);
    if (!canTransition(current.status, to)) {
      throw AppError.conflict("already_resolved", `${current.reference} is already ${current.status}`);
    }
    return current;
  }

  /** Re-checks availability at approval time; stock may have moved since creation. */
  approve(id: string, expectedVersion: number | undefined, actor: Actor, requestId: string): StockRequest {
    const current = this.#pendingFor(id, "approved");
    const version = expectedVersion ?? current.version;
    const result = this.#repository.approve(id, version, actor.name);

    if (result.outcome === "insufficient_stock") {
      const part = this.#parts.findById(current.partId);
      throw AppError.conflict(
        "insufficient_stock",
        `${current.reference} needs ${current.quantity} but only ${part?.stockQuantity ?? 0} available`,
      );
    }
    if (result.outcome === "version_conflict") throw this.#lostRace(id, version);

    this.#audit.record({
      actor: actor.name,
      action: "stock_request.approved",
      entityType: "stock_request",
      entityId: id,
      summary: `${current.reference} approved; ${current.quantity} unit(s) drawn from stock`,
      requestId,
    });
    return result.request;
  }

  reject(id: string, reason: string, expectedVersion: number | undefined, actor: Actor, requestId: string): StockRequest {
    const current = this.#pendingFor(id, "rejected");
    const version = expectedVersion ?? current.version;
    const rejected = this.#repository.decide(id, "rejected", version, actor.name);
    if (!rejected) throw this.#lostRace(id, version);

    this.#audit.record({
      actor: actor.name,
      action: "stock_request.rejected",
      entityType: "stock_request",
      entityId: id,
      summary: `${current.reference} rejected: ${reason}`,
      requestId,
    });
    return rejected;
  }

  /** Only the person named in requestedBy may cancel their own request. */
  cancel(id: string, expectedVersion: number | undefined, actor: Actor, requestId: string): StockRequest {
    const current = this.#pendingFor(id, "cancelled");
    if (current.requestedBy !== actor.name) {
      throw AppError.forbidden(`Only '${current.requestedBy}' may cancel ${current.reference}`);
    }
    const version = expectedVersion ?? current.version;
    const cancelled = this.#repository.decide(id, "cancelled", version, actor.name);
    if (!cancelled) throw this.#lostRace(id, version);

    this.#audit.record({
      actor: actor.name,
      action: "stock_request.cancelled",
      entityType: "stock_request",
      entityId: id,
      summary: `${current.reference} cancelled by requester`,
      requestId,
    });
    return cancelled;
  }

  /**
   * The guarded update matched no row: either someone decided it first
   * (409 already_resolved) or the caller's version is stale (412).
   */
  #lostRace(id: string, expectedVersion: number): AppError {
    const latest = this.getById(id);
    if (latest.status !== "pending") {
      return AppError.conflict("already_resolved", `${latest.reference} is already ${latest.status}`);
    }
    return AppError.versionConflict("Stock request", expectedVersion, latest.version);
  }
}
