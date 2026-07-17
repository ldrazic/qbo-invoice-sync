import type { AccountingProvider } from "./accountingProvider.js";
import type { AppConfig } from "../config.js";
import { FakeProvider } from "./fake/fakeProvider.js";
import { QboProvider } from "./quickbooks/qboProvider.js";
import type { ProviderTokenRepository, ItemMappingRepository } from "../models/repositories/types.js";

export interface ProviderDependencies {
  tokenRepository: ProviderTokenRepository;
  itemMappingRepository: ItemMappingRepository;
}

/**
 * The only place in the codebase that knows which concrete providers exist.
 * Everything else depends on the AccountingProvider interface.
 */
export function createAccountingProvider(
  config: AppConfig,
  deps: ProviderDependencies,
): AccountingProvider {
  switch (config.provider) {
    case "fake":
      return new FakeProvider();
    case "quickbooks":
      return new QboProvider(config.qbo, deps.tokenRepository, deps.itemMappingRepository);
  }
}
