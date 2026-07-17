/**
 * Typed provider errors so the sync pipeline can decide retry behavior
 * without knowing which provider it is talking to.
 */

/** Retryable: network failure, timeout, 5xx, 429. */
export class TransientProviderError extends Error {
  readonly retryable = true;
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "TransientProviderError";
  }
}

/** Not retryable: validation errors, 4xx other than 429/401. */
export class PermanentProviderError extends Error {
  readonly retryable = false;
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "PermanentProviderError";
  }
}

/**
 * Optimistic-lock rejection (QBO stale SyncToken). The pipeline reacts by
 * refetching and re-resolving, never by blind retry.
 */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleVersionError";
  }
}

/**
 * The provider call timed out AFTER the request may have been applied
 * remotely. Callers must run lookup-before-retry to avoid duplicates.
 */
export class AmbiguousWriteError extends TransientProviderError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "AmbiguousWriteError";
  }
}
