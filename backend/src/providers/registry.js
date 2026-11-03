import { validateProviderAdapter } from "./contract.js";

/**
 * Adapters are injected by the server composition root.
 * Empty by design until a provider is selected and credentials are configured.
 */
export function createProviderRegistry(adapters = []) {
  const providers = new Map();
  for (const candidate of adapters) {
    const adapter = validateProviderAdapter(candidate);
    if (providers.has(adapter.id)) {
      throw new Error(`Duplicate provider adapter: ${adapter.id}`);
    }
    providers.set(adapter.id, adapter);
  }

  return Object.freeze({
    list() {
      return [...providers.values()].map((provider) => ({
        id: provider.id,
        capabilities: provider.getCapabilities(),
      }));
    },
    get(id) {
      return providers.get(id) || null;
    },
  });
}
