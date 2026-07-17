import type { CanonicalInvoice, CanonicalPayment } from "../../models/invoice.js";
import { centsToDecimalString, decimalStringToCents } from "../../models/money.js";
import type { ItemMappingRepository } from "../../models/repositories/types.js";
import { PermanentProviderError } from "../errors.js";
import type { QboClient } from "./qboClient.js";

/**
 * Canonical <-> QBO wire format. This file is the ONLY place that knows what
 * a QBO Invoice/Payment JSON looks like. Money converts cents <-> decimal
 * strings exclusively here.
 */

export interface QboInvoiceJson {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  CustomerRef?: { value: string; name?: string };
  CurrencyRef?: { value: string };
  PrivateNote?: string;
  TotalAmt?: number;
  Balance?: number;
  Line?: Array<{
    DetailType?: string;
    Amount?: number;
    Description?: string;
    SalesItemLineDetail?: {
      ItemRef?: { value: string; name?: string };
      Qty?: number;
      UnitPrice?: number;
    };
  }>;
  MetaData?: { LastUpdatedTime?: string };
}

export interface QboPaymentJson {
  Id: string;
  SyncToken: string;
  TotalAmt?: number;
  PaymentRefNum?: string;
  TxnDate?: string;
  PrivateNote?: string;
  CustomerRef?: { value: string };
  Line?: Array<{ Amount?: number; LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }> }>;
  MetaData?: { LastUpdatedTime?: string };
}

export class QboMapper {
  constructor(
    private readonly items: ItemMappingRepository,
    private readonly client: QboClient,
  ) {}

  async toQboInvoiceBody(
    invoice: CanonicalInvoice,
    existing?: { id: string; syncToken: string },
  ): Promise<Record<string, unknown>> {
    const customerId = await this.ensureCustomer(invoice.customerName);
    const lines = [];
    for (const line of invoice.lines) {
      const itemId = await this.resolveItemRef(line.itemCode);
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: Number(centsToDecimalString(line.amountCents)),
        Description: line.description ?? undefined,
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: line.quantity,
          UnitPrice: Number(centsToDecimalString(line.unitPriceCents)),
        },
      });
    }
    return {
      ...(existing ? { Id: existing.id, SyncToken: existing.syncToken, sparse: false } : {}),
      DocNumber: invoice.docNumber,
      CustomerRef: { value: customerId },
      PrivateNote: invoice.notes ?? undefined,
      Line: lines,
    };
  }

  async fromQboInvoice(qbo: QboInvoiceJson): Promise<CanonicalInvoice> {
    const totalCents = decimalStringToCents(qbo.TotalAmt ?? 0);
    const balanceCents = decimalStringToCents(qbo.Balance ?? 0);
    // QBO has no explicit "voided" flag on Invoice: voiding zeroes the
    // amounts and stamps "Voided" into PrivateNote. Heuristic, documented.
    const voided = totalCents === 0 && (qbo.PrivateNote ?? "").includes("Voided");

    const lines = [];
    let lineNo = 0;
    for (const line of qbo.Line ?? []) {
      if (line.DetailType !== "SalesItemLineDetail") continue;
      lineNo += 1;
      const detail = line.SalesItemLineDetail ?? {};
      const externalItemId = detail.ItemRef?.value ?? "";
      const mappedCode = externalItemId
        ? await this.items.getItemCode("quickbooks", externalItemId)
        : null;
      lines.push({
        lineNo,
        itemCode: mappedCode ?? detail.ItemRef?.name ?? `qbo-item-${externalItemId}`,
        description: line.Description ?? null,
        // Internal system models integer quantities (documented assumption).
        quantity: Math.round(detail.Qty ?? 1),
        unitPriceCents: decimalStringToCents(detail.UnitPrice ?? 0),
        amountCents: decimalStringToCents(line.Amount ?? 0),
      });
    }

    const status = voided
      ? ("voided" as const)
      : balanceCents <= 0 && totalCents > 0
        ? ("paid" as const)
        : balanceCents < totalCents
          ? ("partial" as const)
          : ("open" as const);

    return {
      docNumber: qbo.DocNumber ?? "",
      customerName: qbo.CustomerRef?.name ?? (await this.customerName(qbo.CustomerRef?.value)),
      status,
      currency: qbo.CurrencyRef?.value ?? "USD",
      notes: voided ? null : (qbo.PrivateNote ?? null),
      totalCents,
      balanceCents,
      sourceUpdatedAt: qbo.MetaData?.LastUpdatedTime ?? new Date().toISOString(),
      lines,
    };
  }

  async toQboPaymentBody(
    payment: CanonicalPayment,
    invoice: QboInvoiceJson,
  ): Promise<Record<string, unknown>> {
    return {
      TotalAmt: Number(centsToDecimalString(payment.amountCents)),
      CustomerRef: { value: invoice.CustomerRef?.value },
      PaymentRefNum: payment.referenceCode ?? undefined,
      TxnDate: payment.receivedAt.slice(0, 10),
      Line: [
        {
          Amount: Number(centsToDecimalString(payment.amountCents)),
          LinkedTxn: [{ TxnId: invoice.Id, TxnType: "Invoice" }],
        },
      ],
    };
  }

  async fromQboPayment(
    qbo: QboPaymentJson,
    linkedInvoiceDocNumber: string | null,
  ): Promise<CanonicalPayment> {
    return {
      invoiceDocNumber: linkedInvoiceDocNumber ?? "",
      amountCents: decimalStringToCents(qbo.TotalAmt ?? 0),
      method: null,
      receivedAt: qbo.TxnDate ?? qbo.MetaData?.LastUpdatedTime ?? new Date().toISOString(),
      referenceCode: qbo.PaymentRefNum ?? null,
    };
  }

  /** First linked Invoice TxnId in the payment, if any. */
  linkedInvoiceId(qbo: QboPaymentJson): string | null {
    for (const line of qbo.Line ?? []) {
      for (const txn of line.LinkedTxn ?? []) {
        if (txn.TxnType === "Invoice" && txn.TxnId) return txn.TxnId;
      }
    }
    return null;
  }

  /** Find-or-create a QBO customer by display name. */
  async ensureCustomer(name: string): Promise<string> {
    const escaped = name.replace(/'/g, "\\'");
    const result = await this.client.query(
      `SELECT Id FROM Customer WHERE DisplayName = '${escaped}'`,
    );
    const found = (result.Customer as Array<{ Id: string }> | undefined)?.[0];
    if (found) return found.Id;
    const created = await this.client.post("/customer", { DisplayName: name });
    return (created.Customer as { Id: string }).Id;
  }

  /**
   * internal item_code -> QBO ItemRef. Static mapping table first; falls back
   * to a lookup by item Name in QBO (and caches the result in the table).
   * Full chart-of-accounts sync is deliberately out of scope.
   */
  private async resolveItemRef(itemCode: string): Promise<string> {
    const mapped = await this.items.getExternalItemId("quickbooks", itemCode);
    if (mapped) return mapped;
    const escaped = itemCode.replace(/'/g, "\\'");
    const result = await this.client.query(`SELECT Id, Name FROM Item WHERE Name = '${escaped}'`);
    const found = (result.Item as Array<{ Id: string; Name: string }> | undefined)?.[0];
    if (!found) {
      throw new PermanentProviderError(
        `no QBO item mapping for item_code "${itemCode}"; seed item_mappings or create the item in QBO`,
      );
    }
    await this.items.upsert("quickbooks", itemCode, found.Id, found.Name);
    return found.Id;
  }

  private async customerName(customerId: string | undefined): Promise<string> {
    if (!customerId) return "Unknown customer";
    const result = await this.client.get(`/customer/${customerId}`);
    const customer = result?.Customer as { DisplayName?: string } | undefined;
    return customer?.DisplayName ?? "Unknown customer";
  }
}
