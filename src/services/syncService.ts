import type { AccountingProvider, ExternalInvoiceState } from "../providers/accountingProvider.js";
import {
  paymentReferenceCode,
  snapshotHash,
  toComparable,
  type CanonicalInvoice,
  type ComparableInvoice,
} from "../models/invoice.js";
import { resolve, type Resolution } from "./conflictResolver.js";
import type { InboundEvent } from "../queue/eventQueue.js";
import type {
  AuditAction,
  AuditRepository,
  EntityLink,
  EntityLinkRepository,
  InternalInvoice,
  InternalInvoiceRepository,
} from "../models/repositories/types.js";

/**
 * Pipeline per inbound event (already deduped by the inbox):
 * refetch both sides -> suppress echoes of our own writes -> resolve against
 * the last synced snapshot (last write wins on conflict) -> apply with
 * optimistic locking -> persist the new common ancestor + audit the decision.
 *
 * Because processing always starts from refetched state, duplicate and
 * out-of-order events degrade into no-ops.
 */

export type SyncOutcome = { kind: "ok" | "skip"; action: string };

export interface SyncServiceDeps {
  provider: AccountingProvider;
  links: EntityLinkRepository;
  audit: AuditRepository;
  internalInvoices: InternalInvoiceRepository;
}

export class SyncService {
  private readonly provider: AccountingProvider;
  private readonly links: EntityLinkRepository;
  private readonly audit: AuditRepository;
  private readonly internal: InternalInvoiceRepository;

  constructor(deps: SyncServiceDeps) {
    this.provider = deps.provider;
    this.links = deps.links;
    this.audit = deps.audit;
    this.internal = deps.internalInvoices;
  }

  async processEvent(event: InboundEvent): Promise<SyncOutcome> {
    if (event.entityType === "invoice") return this.processInvoiceEvent(event);
    if (event.entityType === "payment") return this.processPaymentEvent(event);
    return this.skip(event, "skipped_noop", { reason: `unsupported entity ${event.entityType}` });
  }

  // =========================================================================
  // Invoices
  // =========================================================================

  private async processInvoiceEvent(event: InboundEvent): Promise<SyncOutcome> {
    const fromInternal = event.source === "internal";
    const link = fromInternal
      ? await this.links.findByInternalId(this.provider.name, "invoice", event.entityId)
      : await this.links.findByExternalId(this.provider.name, "invoice", event.entityId);

    if (!link) {
      return fromInternal
        ? this.handleUnlinkedInternal(event)
        : this.handleUnlinkedExternal(event);
    }
    return this.handleLinked(event, link);
  }

  private async handleUnlinkedInternal(event: InboundEvent): Promise<SyncOutcome> {
    const internal = await this.internal.get(event.entityId);
    if (!internal) {
      return this.skip(event, "skipped_stale", { reason: "internal invoice no longer exists" });
    }
    if (internal.status === "deleted" || internal.status === "voided") {
      return this.skip(event, "skipped_noop", { reason: "unlinked invoice already terminal" });
    }
    const canonical = this.internal.toCanonical(internal);

    // Lookup-before-create: covers pre-existing unlinked records in the
    // provider AND recovery after a create that timed out post-write.
    const existing = await this.provider.findInvoiceByDocNumber(canonical.docNumber);
    if (existing && existing.invoice) {
      return this.linkExisting(event, internal, { ...existing, invoice: existing.invoice });
    }

    const created = await this.provider.createInvoice(canonical);
    const comparable = toComparable(canonical);
    const link = await this.links.create({
      provider: this.provider.name,
      entityType: "invoice",
      internalId: internal.id,
      externalId: created.externalId,
      externalSyncToken: created.syncToken,
      internalVersion: internal.version,
      lastSyncedHash: snapshotHash(comparable),
      lastSyncedSnapshot: comparable,
    });
    await this.links.markSynced(link.id, {
      externalSyncToken: created.syncToken,
      internalVersion: internal.version,
      hash: snapshotHash(comparable),
      snapshot: comparable,
    });
    await this.audit.record({
      inboundEventId: event.id,
      entityType: "invoice",
      internalId: internal.id,
      externalId: created.externalId,
      action: "applied",
      detail: { direction: "internal->external", operation: "create", docNumber: canonical.docNumber },
    });
    return { kind: "ok", action: "applied" };
  }

  private async handleUnlinkedExternal(event: InboundEvent): Promise<SyncOutcome> {
    const external = await this.provider.getInvoice(event.entityId);
    if (!external || !external.invoice) {
      return this.skip(event, "skipped_stale", {
        reason: "external invoice deleted before we ever linked it",
      });
    }
    const docNumber = external.invoice.docNumber;
    const internal = await this.internal.getByDocNumber(docNumber);
    if (internal) {
      return this.linkExisting(event, internal, { ...external, invoice: external.invoice });
    }

    const created = await this.internal.applyCanonical(external.invoice);
    const comparable = toComparable(external.invoice);
    const link = await this.links.create({
      provider: this.provider.name,
      entityType: "invoice",
      internalId: created.id,
      externalId: external.externalId,
      externalSyncToken: external.syncToken,
      internalVersion: created.version,
      lastSyncedHash: snapshotHash(comparable),
      lastSyncedSnapshot: comparable,
    });
    await this.links.markSynced(link.id, {
      externalSyncToken: external.syncToken,
      internalVersion: created.version,
      hash: snapshotHash(comparable),
      snapshot: comparable,
    });
    await this.audit.record({
      inboundEventId: event.id,
      entityType: "invoice",
      internalId: created.id,
      externalId: external.externalId,
      action: "applied",
      detail: { direction: "external->internal", operation: "create", docNumber },
    });
    return { kind: "ok", action: "applied" };
  }

  /**
   * Same docNumber on both sides with no linkage record. Link them; if their
   * states already agree we are done (also the recovery path after a
   * timed-out create). If they diverge, last write wins.
   */
  private async linkExisting(
    event: InboundEvent,
    internal: InternalInvoice,
    external: ExternalInvoiceState & { invoice: CanonicalInvoice },
  ): Promise<SyncOutcome> {
    const internalCanonical = this.internal.toCanonical(internal);
    const internalComparable = toComparable(internalCanonical);
    const externalComparable = toComparable(external.invoice);
    const equal = snapshotHash(internalComparable) === snapshotHash(externalComparable);

    const link = await this.links.create({
      provider: this.provider.name,
      entityType: "invoice",
      internalId: internal.id,
      externalId: external.externalId,
      externalSyncToken: external.syncToken,
      internalVersion: internal.version,
      lastSyncedHash: equal ? snapshotHash(internalComparable) : null,
      lastSyncedSnapshot: equal ? internalComparable : null,
    });

    if (equal) {
      await this.links.markSynced(link.id, {
        externalSyncToken: external.syncToken,
        internalVersion: internal.version,
        hash: snapshotHash(internalComparable),
        snapshot: internalComparable,
      });
      await this.audit.record({
        inboundEventId: event.id,
        entityType: "invoice",
        internalId: internal.id,
        externalId: external.externalId,
        action: "linked_existing",
        detail: { docNumber: internal.docNumber, statesMatched: true },
      });
      return { kind: "ok", action: "linked_existing" };
    }

    const resolution = resolve({
      base: null,
      internal: internalComparable,
      external: externalComparable,
      internalUpdatedAt: internal.updatedAt,
      externalUpdatedAt: new Date(external.invoice.sourceUpdatedAt),
    });
    return this.applyResolution(event, link, resolution, {
      internal,
      internalCanonical,
      externalState: external,
    });
  }

  private async handleLinked(event: InboundEvent, link: EntityLink): Promise<SyncOutcome> {
    const internal = await this.internal.get(link.internalId);
    if (!internal) {
      return this.skip(event, "skipped_stale", { reason: "internal invoice missing despite link" });
    }
    const internalCanonical = this.internal.toCanonical(internal);
    const internalComparable = toComparable(internalCanonical);

    const externalState = await this.provider.getInvoice(link.externalId);
    // A hard-deleted provider record is modeled as "the external side changed
    // its lifecycle to deleted", so the resolver sees a normal change.
    const externalComparable: ComparableInvoice =
      externalState && externalState.invoice
        ? toComparable(externalState.invoice)
        : { ...(link.lastSyncedSnapshot ?? internalComparable), lifecycle: "deleted" };

    const eventSideHash = snapshotHash(
      event.source === "internal" ? internalComparable : externalComparable,
    );
    if (link.lastSyncedHash !== null && eventSideHash === link.lastSyncedHash) {
      return this.skip(event, "skipped_echo", {
        internalId: link.internalId,
        externalId: link.externalId,
        reason: "event-side state equals last synced snapshot (own write or stale event)",
      });
    }

    const externalUpdatedAt = externalState?.invoice
      ? new Date(externalState.invoice.sourceUpdatedAt)
      : event.source !== "internal"
        ? event.occurredAt
        : (link.lastSyncedAt ?? new Date(0));

    const resolution = resolve({
      base: link.lastSyncedSnapshot,
      internal: internalComparable,
      external: externalComparable,
      internalUpdatedAt: internal.updatedAt,
      externalUpdatedAt,
    });

    return this.applyResolution(event, link, resolution, {
      internal,
      internalCanonical,
      externalState,
    });
  }

  private async applyResolution(
    event: InboundEvent,
    link: EntityLink,
    resolution: Resolution,
    ctx: {
      internal: InternalInvoice;
      internalCanonical: CanonicalInvoice;
      externalState: ExternalInvoiceState | null;
    },
  ): Promise<SyncOutcome> {
    if (resolution.kind === "noop") {
      const comparable = toComparable(ctx.internalCanonical);
      await this.links.markSynced(link.id, {
        externalSyncToken: ctx.externalState?.syncToken ?? link.externalSyncToken,
        internalVersion: ctx.internal.version,
        hash: snapshotHash(comparable),
        snapshot: comparable,
      });
      return this.skip(event, "skipped_noop", { reason: "sides already convergent" });
    }

    const { merged, writeInternal, writeExternal, decision, overwritten } = resolution;
    const mergedCanonical: CanonicalInvoice = {
      docNumber: merged.docNumber,
      customerName: merged.customerName,
      status: merged.lifecycle === "active" ? "open" : merged.lifecycle,
      currency: merged.currency,
      notes: merged.notes,
      totalCents: merged.totalCents,
      balanceCents: merged.totalCents,
      sourceUpdatedAt: new Date().toISOString(),
      lines: merged.lines.map((l) => ({ ...l })),
    };

    // Write external first, then internal, then advance the common ancestor.
    // A crash in between converges on reprocessing: the already-written side
    // diffs as unchanged against the merged state.
    let newSyncToken = ctx.externalState?.syncToken ?? link.externalSyncToken;
    let externalId = link.externalId;
    if (writeExternal) {
      if (!ctx.externalState) {
        // Hard-deleted externally but the internal (newer) state wins:
        // recreate and re-point the link.
        const created = await this.provider.createInvoice(mergedCanonical);
        await this.links.updateExternalId(link.id, created.externalId);
        externalId = created.externalId;
        newSyncToken = created.syncToken;
      } else if (merged.lifecycle === "voided" || merged.lifecycle === "deleted") {
        // Internal deletes become provider VOIDS: hard-deleting in the
        // accounting system would destroy the audit trail.
        const voided = await this.provider.voidInvoice(
          ctx.externalState.externalId,
          ctx.externalState.syncToken,
        );
        newSyncToken = voided.syncToken;
      } else {
        const updated = await this.provider.updateInvoice(
          ctx.externalState.externalId,
          ctx.externalState.syncToken,
          mergedCanonical,
        );
        newSyncToken = updated.syncToken;
      }
    }

    let newInternalVersion = ctx.internal.version;
    if (writeInternal) {
      if (merged.lifecycle === "voided" || merged.lifecycle === "deleted") {
        const updated = await this.internal.setLifecycle(ctx.internal.id, merged.lifecycle);
        newInternalVersion = updated.version;
      } else {
        const updated = await this.internal.applyCanonical(mergedCanonical, ctx.internal.id);
        newInternalVersion = updated.version;
      }
    }

    await this.links.markSynced(link.id, {
      externalSyncToken: newSyncToken,
      internalVersion: newInternalVersion,
      hash: snapshotHash(merged),
      snapshot: merged,
    });

    const wasLww = decision === "lww_internal" || decision === "lww_external";
    await this.audit.record({
      inboundEventId: event.id,
      entityType: "invoice",
      internalId: link.internalId,
      externalId,
      action: wasLww ? "conflict_lww" : "applied",
      detail: {
        decision,
        wroteInternal: writeInternal,
        wroteExternal: writeExternal,
        ...(overwritten ? { overwritten } : {}),
      },
    });
    return { kind: "ok", action: wasLww ? "conflict_lww" : "applied" };
  }

  // =========================================================================
  // Payments (immutable once created; sync = replicate to the other side)
  // =========================================================================

  private async processPaymentEvent(event: InboundEvent): Promise<SyncOutcome> {
    return event.source === "internal"
      ? this.processInternalPayment(event)
      : this.processExternalPayment(event);
  }

  private async processInternalPayment(event: InboundEvent): Promise<SyncOutcome> {
    const existingLink = await this.links.findByInternalId(
      this.provider.name,
      "payment",
      event.entityId,
    );
    if (existingLink) {
      return this.skip(event, "skipped_duplicate", { reason: "payment already synced" });
    }

    const payment = await this.internal.getPayment(event.entityId);
    if (!payment) {
      return this.skip(event, "skipped_stale", { reason: "internal payment no longer exists" });
    }
    const invoice = await this.internal.get(payment.invoiceId);
    if (!invoice) {
      return this.skip(event, "skipped_stale", { reason: "invoice for payment missing" });
    }
    const invoiceLink = await this.links.findByInternalId(
      this.provider.name,
      "invoice",
      invoice.id,
    );
    if (!invoiceLink) {
      // The invoice's own event will create the link; retry this one later.
      throw new Error(`invoice ${invoice.id} not linked yet; retrying payment later`);
    }

    const referenceCode = paymentReferenceCode(event.entityId);
    const canonical = {
      amountCents: payment.amountCents,
      method: payment.method,
      receivedAt: payment.receivedAt.toISOString(),
      allocations: [{ invoiceDocNumber: invoice.docNumber, amountCents: payment.amountCents }],
      referenceCode,
    };

    // Lookup-before-create: ambiguous-write recovery.
    let external = await this.provider.findPaymentByReference(referenceCode);
    let action: AuditAction = "applied";
    let recovered = false;
    if (external) {
      action = "recovered_orphan_write";
      recovered = true;
    } else {
      external = await this.provider.createPayment(canonical, invoiceLink.externalId);
    }

    // The provider may store a different allocation than was requested (QBO
    // re-applies to another open invoice, or holds the money as credit). The
    // internal row stands — the money was received — but auditing the request
    // instead of the result would hide a real divergence between the systems.
    const appliedToInvoice = (external.payment?.allocations ?? [])
      .filter((allocation) => allocation.invoiceDocNumber === invoice.docNumber)
      .reduce((sum, allocation) => sum + allocation.amountCents, 0);
    if (appliedToInvoice !== payment.amountCents) {
      action = "applied_divergent";
    }

    await this.links.create({
      provider: this.provider.name,
      entityType: "payment",
      internalId: event.entityId,
      externalId: external.externalId,
      externalSyncToken: external.syncToken,
      internalVersion: null,
      lastSyncedHash: null,
      lastSyncedSnapshot: null,
    });
    await this.audit.record({
      inboundEventId: event.id,
      entityType: "payment",
      internalId: event.entityId,
      externalId: external.externalId,
      action,
      detail: {
        direction: "internal->external",
        amountCents: payment.amountCents,
        invoiceDocNumber: invoice.docNumber,
        appliedAllocations: external.payment?.allocations ?? [],
        ...(recovered ? { recovered: true } : {}),
        ...(action === "applied_divergent"
          ? {
              divergence:
                `provider applied ${appliedToInvoice} of ${payment.amountCents} cents ` +
                `to ${invoice.docNumber}`,
            }
          : {}),
      },
    });
    return { kind: "ok", action };
  }

  private async processExternalPayment(event: InboundEvent): Promise<SyncOutcome> {
    const existingLink = await this.links.findByExternalId(
      this.provider.name,
      "payment",
      event.entityId,
    );
    if (existingLink) {
      return this.skip(event, "skipped_echo", { reason: "payment already linked" });
    }

    const external = await this.provider.getPayment(event.entityId);
    if (!external || !external.payment) {
      return this.skip(event, "skipped_stale", { reason: "external payment no longer exists" });
    }
    const { allocations } = external.payment;
    if (allocations.length === 0) {
      return this.skip(event, "skipped_noop", {
        reason: "payment has no invoice allocations (unapplied/credit payment)",
      });
    }

    // Resolve every allocation's invoice before writing anything, so a
    // missing invoice retries the whole event instead of half-applying.
    const targets = [];
    for (const allocation of allocations) {
      const invoice = await this.internal.getByDocNumber(allocation.invoiceDocNumber);
      if (!invoice) {
        throw new Error(
          `internal invoice ${allocation.invoiceDocNumber} not found for payment; retrying later`,
        );
      }
      targets.push({ allocation, invoice });
    }

    // One internal payment row per allocation, each idempotent on its
    // external_ref — a crash anywhere in this loop converges on retry.
    const applied = [];
    for (const { allocation, invoice } of targets) {
      const result = await this.internal.applyExternalPayment(
        invoice.id,
        {
          amountCents: allocation.amountCents,
          method: external.payment.method ?? "other",
          receivedAt: new Date(external.payment.receivedAt),
        },
        `${this.provider.name}:payment:${event.entityId}:${allocation.invoiceDocNumber}`,
      );
      applied.push({
        invoiceDocNumber: allocation.invoiceDocNumber,
        amountCents: allocation.amountCents,
        paymentId: result.paymentId,
        deduplicated: !result.created,
      });
    }

    await this.links.create({
      provider: this.provider.name,
      entityType: "payment",
      internalId: applied[0]!.paymentId,
      externalId: event.entityId,
      externalSyncToken: external.syncToken,
      internalVersion: null,
      lastSyncedHash: null,
      lastSyncedSnapshot: null,
    });
    await this.audit.record({
      inboundEventId: event.id,
      entityType: "payment",
      internalId: applied[0]!.paymentId,
      externalId: event.entityId,
      action: "applied",
      detail: {
        direction: "external->internal",
        totalCents: external.payment.amountCents,
        allocations: applied,
      },
    });
    return { kind: "ok", action: "applied" };
  }

  // =========================================================================

  private async skip(
    event: InboundEvent,
    action: "skipped_echo" | "skipped_stale" | "skipped_noop" | "skipped_duplicate",
    detail: Record<string, unknown>,
  ): Promise<SyncOutcome> {
    await this.audit.record({
      inboundEventId: event.id,
      entityType: event.entityType,
      action,
      detail,
    });
    return { kind: "skip", action };
  }
}
