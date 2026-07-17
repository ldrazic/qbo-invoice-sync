import { stableStringify } from "../models/invoice.js";
import type { ComparableInvoice } from "../models/invoice.js";

/**
 * Conflict policy: LAST WRITE WINS.
 *
 * - Only one side changed since the last synced snapshot -> propagate it.
 * - Both sides changed (or there is no common ancestor) -> the side with the
 *   most recent modification timestamp wins wholesale; the other side is
 *   overwritten. Ties go to the external system (the accounting system of
 *   record). The overwritten state is preserved in the audit log.
 *
 * Trade-offs (accepted, documented in the README): concurrent edits to
 * different fields lose the older side's edit, and correctness depends on
 * both systems' clocks.
 */

function equals(a: ComparableInvoice, b: ComparableInvoice | null): boolean {
  return b !== null && stableStringify(a) === stableStringify(b);
}

export interface ResolutionContext {
  base: ComparableInvoice | null;
  internal: ComparableInvoice;
  external: ComparableInvoice;
  internalUpdatedAt: Date;
  externalUpdatedAt: Date;
}

export type Decision =
  | "one_sided_internal"
  | "one_sided_external"
  | "lww_internal"
  | "lww_external";

export type Resolution =
  | { kind: "noop" }
  | {
      kind: "apply";
      merged: ComparableInvoice;
      writeInternal: boolean;
      writeExternal: boolean;
      decision: Decision;
      overwritten: ComparableInvoice | null;
    };

export function resolve(ctx: ResolutionContext): Resolution {
  const { base, internal, external } = ctx;

  if (stableStringify(internal) === stableStringify(external)) {
    return { kind: "noop" };
  }

  const internalChanged = !equals(internal, base);
  const externalChanged = !equals(external, base);

  let decision: Decision;
  if (base !== null && internalChanged && !externalChanged) {
    decision = "one_sided_internal";
  } else if (base !== null && externalChanged && !internalChanged) {
    decision = "one_sided_external";
  } else {
    // Real conflict (or no ancestor to tell): last write wins.
    decision =
      ctx.internalUpdatedAt.getTime() > ctx.externalUpdatedAt.getTime()
        ? "lww_internal"
        : "lww_external";
  }

  const internalWins = decision === "one_sided_internal" || decision === "lww_internal";
  const merged = internalWins ? internal : external;
  const isLww = decision === "lww_internal" || decision === "lww_external";

  return {
    kind: "apply",
    merged,
    writeInternal: !internalWins,
    writeExternal: internalWins,
    decision,
    overwritten: isLww ? (internalWins ? external : internal) : null,
  };
}
