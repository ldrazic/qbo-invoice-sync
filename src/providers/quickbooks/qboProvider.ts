import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AccountingProvider,
  ExternalInvoiceState,
  ExternalPaymentState,
  ProviderWebhookEvent,
} from "../accountingProvider.js";
import type { CanonicalInvoice, CanonicalPayment } from "../../models/invoice.js";
import type { QboConfig } from "../../config.js";
import type {
  ItemMappingRepository,
  ProviderTokenRepository,
} from "../../models/repositories/types.js";
import { QboAuth } from "./qboAuth.js";
import { QboClient } from "./qboClient.js";
import { QboMapper, type QboInvoiceJson, type QboPaymentJson } from "./qboMapper.js";

export class QboProvider implements AccountingProvider {
  readonly name = "quickbooks";
  readonly auth: QboAuth;
  private readonly client: QboClient;
  private readonly mapper: QboMapper;

  constructor(
    private readonly config: QboConfig,
    tokenRepository: ProviderTokenRepository,
    itemMappings: ItemMappingRepository,
  ) {
    this.auth = new QboAuth(config, tokenRepository);
    this.client = new QboClient(config, this.auth);
    this.mapper = new QboMapper(itemMappings, this.client);
  }

  // --- invoices ---

  async getInvoice(externalId: string): Promise<ExternalInvoiceState | null> {
    const result = await this.client.get(`/invoice/${externalId}`);
    const qbo = result?.Invoice as QboInvoiceJson | undefined;
    if (!qbo) return null; // hard-deleted or never existed (QBO fault 610)
    return {
      externalId: qbo.Id,
      syncToken: qbo.SyncToken,
      invoice: await this.mapper.fromQboInvoice(qbo),
    };
  }

  async findInvoiceByDocNumber(docNumber: string): Promise<ExternalInvoiceState | null> {
    const escaped = docNumber.replace(/'/g, "\\'");
    const result = await this.client.query(
      `SELECT * FROM Invoice WHERE DocNumber = '${escaped}'`,
    );
    const qbo = (result.Invoice as QboInvoiceJson[] | undefined)?.[0];
    if (!qbo) return null;
    return {
      externalId: qbo.Id,
      syncToken: qbo.SyncToken,
      invoice: await this.mapper.fromQboInvoice(qbo),
    };
  }

  async createInvoice(invoice: CanonicalInvoice): Promise<ExternalInvoiceState> {
    const body = await this.mapper.toQboInvoiceBody(invoice);
    const result = await this.client.post("/invoice", body);
    const qbo = result.Invoice as QboInvoiceJson;
    return {
      externalId: qbo.Id,
      syncToken: qbo.SyncToken,
      invoice: await this.mapper.fromQboInvoice(qbo),
    };
  }

  async updateInvoice(
    externalId: string,
    syncToken: string,
    invoice: CanonicalInvoice,
  ): Promise<ExternalInvoiceState> {
    const body = await this.mapper.toQboInvoiceBody(invoice, { id: externalId, syncToken });
    const result = await this.client.post("/invoice", body);
    const qbo = result.Invoice as QboInvoiceJson;
    return {
      externalId: qbo.Id,
      syncToken: qbo.SyncToken,
      invoice: await this.mapper.fromQboInvoice(qbo),
    };
  }

  async voidInvoice(externalId: string, syncToken: string): Promise<ExternalInvoiceState> {
    const result = await this.client.post("/invoice?operation=void", {
      Id: externalId,
      SyncToken: syncToken,
    });
    const qbo = result.Invoice as QboInvoiceJson;
    return {
      externalId: qbo.Id,
      syncToken: qbo.SyncToken,
      invoice: await this.mapper.fromQboInvoice(qbo),
    };
  }

  // --- payments ---

  async getPayment(externalId: string): Promise<ExternalPaymentState | null> {
    const result = await this.client.get(`/payment/${externalId}`);
    const qbo = result?.Payment as QboPaymentJson | undefined;
    if (!qbo) return null;
    return this.toPaymentState(qbo);
  }

  async findPaymentByReference(referenceCode: string): Promise<ExternalPaymentState | null> {
    const escaped = referenceCode.replace(/'/g, "\\'");
    const result = await this.client.query(
      `SELECT * FROM Payment WHERE PaymentRefNum = '${escaped}'`,
    );
    const qbo = (result.Payment as QboPaymentJson[] | undefined)?.[0];
    if (!qbo) return null;
    return this.toPaymentState(qbo);
  }

  async createPayment(
    payment: CanonicalPayment,
    invoiceExternalId: string,
  ): Promise<ExternalPaymentState> {
    const invoiceResult = await this.client.get(`/invoice/${invoiceExternalId}`);
    const invoice = invoiceResult?.Invoice as QboInvoiceJson | undefined;
    if (!invoice) {
      throw new Error(`QBO invoice ${invoiceExternalId} not found while creating payment`);
    }
    const body = await this.mapper.toQboPaymentBody(payment, invoice);
    const result = await this.client.post("/payment", body);
    const qbo = result.Payment as QboPaymentJson;
    return {
      externalId: qbo.Id,
      syncToken: qbo.SyncToken,
      payment: await this.mapper.fromQboPayment(qbo, invoice.DocNumber ?? null),
    };
  }

  private async toPaymentState(qbo: QboPaymentJson): Promise<ExternalPaymentState> {
    // Payment webhooks/records don't carry the invoice DocNumber; resolve it
    // through the linked transaction.
    const linkedInvoiceId = this.mapper.linkedInvoiceId(qbo);
    let docNumber: string | null = null;
    if (linkedInvoiceId) {
      const invoiceResult = await this.client.get(`/invoice/${linkedInvoiceId}`);
      docNumber = (invoiceResult?.Invoice as QboInvoiceJson | undefined)?.DocNumber ?? null;
    }
    return {
      externalId: qbo.Id,
      syncToken: qbo.SyncToken,
      payment: await this.mapper.fromQboPayment(qbo, docNumber),
    };
  }

  // --- webhooks ---

  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature || !this.config.webhookVerifierToken) return false;
    const expected = createHmac("sha256", this.config.webhookVerifierToken)
      .update(rawBody)
      .digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): ProviderWebhookEvent[] {
    const payload = JSON.parse(rawBody) as {
      eventNotifications?: Array<{
        realmId?: string;
        dataChangeEvent?: {
          entities?: Array<{ name?: string; id?: string; operation?: string; lastUpdated?: string }>;
        };
      }>;
    };
    const events: ProviderWebhookEvent[] = [];
    for (const notification of payload.eventNotifications ?? []) {
      for (const entity of notification.dataChangeEvent?.entities ?? []) {
        const name = (entity.name ?? "").toLowerCase();
        if (name !== "invoice" && name !== "payment") continue;
        if (!entity.id || !entity.operation) continue;
        const operation = entity.operation.toLowerCase() as ProviderWebhookEvent["operation"];
        const occurredAt = entity.lastUpdated ?? new Date().toISOString();
        events.push({
          entityType: name,
          entityId: entity.id,
          operation,
          occurredAt,
          dedupeKey: `quickbooks:${name}:${entity.id}:${operation}:${occurredAt}`,
        });
      }
    }
    return events;
  }
}
