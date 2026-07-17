import { centsToDecimalString } from "../models/money.js";
import type { InternalInvoice } from "../models/repositories/types.js";

/** JSON shape returned by the internal invoicing API. */
export function invoiceView(invoice: InternalInvoice) {
  return {
    id: invoice.id,
    docNumber: invoice.docNumber,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    status: invoice.status,
    currency: invoice.currency,
    notes: invoice.notes,
    total: centsToDecimalString(invoice.totalCents),
    balance: centsToDecimalString(invoice.balanceCents),
    totalCents: invoice.totalCents,
    balanceCents: invoice.balanceCents,
    version: invoice.version,
    updatedAt: invoice.updatedAt.toISOString(),
    lines: invoice.lines.map((l) => ({
      lineNo: l.lineNo,
      itemCode: l.itemCode,
      description: l.description,
      quantity: l.quantity,
      unitPrice: centsToDecimalString(l.unitPriceCents),
      amount: centsToDecimalString(l.amountCents),
    })),
    payments: invoice.payments.map((p) => ({
      id: p.id,
      amount: centsToDecimalString(p.amountCents),
      method: p.method,
      receivedAt: p.receivedAt.toISOString(),
    })),
  };
}
