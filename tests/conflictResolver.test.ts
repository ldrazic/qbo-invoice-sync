import { describe, expect, it } from "vitest";
import { resolve } from "../src/services/conflictResolver.js";
import type { ComparableInvoice } from "../src/models/invoice.js";

const T1 = new Date("2026-07-01T10:00:00Z");
const T2 = new Date("2026-07-01T11:00:00Z");

function invoice(overrides: Partial<ComparableInvoice> = {}): ComparableInvoice {
  return {
    docNumber: "INV-1001",
    customerName: "Acme Corp",
    lifecycle: "active",
    currency: "USD",
    notes: null,
    totalCents: 10_000,
    lines: [
      {
        lineNo: 1,
        itemCode: "Services",
        description: "Consulting",
        quantity: 1,
        unitPriceCents: 10_000,
        amountCents: 10_000,
      },
    ],
    ...overrides,
  };
}

describe("conflictResolver.resolve (last write wins)", () => {
  it("returns noop when both sides are identical", () => {
    const result = resolve({
      base: invoice(),
      internal: invoice(),
      external: invoice(),
      internalUpdatedAt: T1,
      externalUpdatedAt: T2,
    });
    expect(result.kind).toBe("noop");
  });

  it("propagates a one-sided internal edit regardless of timestamps", () => {
    const result = resolve({
      base: invoice(),
      internal: invoice({ notes: "edited internally" }),
      external: invoice(),
      internalUpdatedAt: T1, // older than external's timestamp...
      externalUpdatedAt: T2, // ...but external did not change anything
      });
    expect(result).toMatchObject({
      kind: "apply",
      decision: "one_sided_internal",
      writeInternal: false,
      writeExternal: true,
    });
    if (result.kind === "apply") expect(result.merged.notes).toBe("edited internally");
  });

  it("propagates a one-sided external edit", () => {
    const result = resolve({
      base: invoice(),
      internal: invoice(),
      external: invoice({ totalCents: 20_000 }),
      internalUpdatedAt: T2,
      externalUpdatedAt: T1,
    });
    expect(result).toMatchObject({
      kind: "apply",
      decision: "one_sided_external",
      writeInternal: true,
      writeExternal: false,
    });
  });

  it("resolves both-sides edits by taking the newer write wholesale", () => {
    const result = resolve({
      base: invoice(),
      internal: invoice({ notes: "internal note" }), // older
      external: invoice({ totalCents: 25_000 }), // newer
      internalUpdatedAt: T1,
      externalUpdatedAt: T2,
    });
    expect(result).toMatchObject({ kind: "apply", decision: "lww_external" });
    if (result.kind === "apply") {
      expect(result.merged.totalCents).toBe(25_000);
      // The older side's disjoint edit is overwritten — accepted LWW trade-off,
      // preserved in `overwritten` for the audit log.
      expect(result.merged.notes).toBeNull();
      expect(result.overwritten?.notes).toBe("internal note");
      expect(result.writeInternal).toBe(true);
    }
  });

  it("lets the internal side win when its write is newer", () => {
    const result = resolve({
      base: invoice(),
      internal: invoice({ notes: "newer internal edit" }),
      external: invoice({ notes: "older external edit" }),
      internalUpdatedAt: T2,
      externalUpdatedAt: T1,
    });
    expect(result).toMatchObject({ kind: "apply", decision: "lww_internal" });
    if (result.kind === "apply") expect(result.merged.notes).toBe("newer internal edit");
  });

  it("breaks timestamp ties in favor of the external system", () => {
    const result = resolve({
      base: invoice(),
      internal: invoice({ notes: "internal" }),
      external: invoice({ notes: "external" }),
      internalUpdatedAt: T1,
      externalUpdatedAt: T1,
    });
    expect(result).toMatchObject({ kind: "apply", decision: "lww_external" });
  });

  it("applies LWW when there is no common ancestor", () => {
    const result = resolve({
      base: null,
      internal: invoice({ notes: "mine" }),
      external: invoice({ notes: "theirs" }),
      internalUpdatedAt: T2,
      externalUpdatedAt: T1,
    });
    expect(result).toMatchObject({ kind: "apply", decision: "lww_internal" });
  });

  it("resolves void-vs-edit by recency: a newer void wins", () => {
    const result = resolve({
      base: invoice(),
      internal: invoice({ lifecycle: "voided", totalCents: 0 }),
      external: invoice({ notes: "kept editing" }),
      internalUpdatedAt: T2,
      externalUpdatedAt: T1,
    });
    expect(result).toMatchObject({ kind: "apply", decision: "lww_internal" });
    if (result.kind === "apply") expect(result.merged.lifecycle).toBe("voided");
  });

  it("resolves void-vs-edit by recency: a newer edit resurrects the invoice", () => {
    const result = resolve({
      base: invoice(),
      internal: invoice({ lifecycle: "voided", totalCents: 0 }),
      external: invoice({ notes: "kept editing" }),
      internalUpdatedAt: T1,
      externalUpdatedAt: T2,
    });
    expect(result).toMatchObject({ kind: "apply", decision: "lww_external" });
    if (result.kind === "apply") {
      expect(result.merged.lifecycle).toBe("active");
      expect(result.overwritten?.lifecycle).toBe("voided");
    }
  });
});
