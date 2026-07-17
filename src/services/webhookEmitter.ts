/**
 * The internal system notifies the sync service of its own changes the same
 * way QBO does: an HTTP webhook. Even though both run in one process, going
 * over HTTP keeps the integration shape honest (and lets the demo replay,
 * duplicate, or delay deliveries with plain curl).
 */

export interface InternalChangeEvent {
  entityType: "invoice" | "payment";
  entityId: string;
  operation: "create" | "update" | "void" | "delete";
  /** Version of the invoice after the change (dedupe key component). */
  version: number;
  occurredAt: string;
}

export class WebhookEmitter {
  constructor(private readonly targetUrl: string) {}

  /** Fire-and-forget: a lost webhook is a reality we must tolerate anyway. */
  emit(event: InternalChangeEvent): void {
    void fetch(this.targetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }).catch((err) => {
      console.error("internal webhook delivery failed:", err.message);
    });
  }
}
