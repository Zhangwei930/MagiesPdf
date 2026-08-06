'use strict';

/**
 * The list of model providers the user has configured.
 *
 * Settings used to hold one endpoint and one model, with a single API key in
 * safeStorage under `apiKey`. That shape is still on disk for anyone who
 * configured the app before this existed, so it is migrated here rather than
 * rewritten in place: `normalizeProviders` reads either shape and always hands
 * back a list. The migrated entry deliberately keeps the id `legacy` because
 * `secretKeyForProvider` maps that id back to the original `apiKey` secret —
 * an upgrade must not silently lose the key the user already stored.
 *
 * Pure: no fs, no electron. The service owns reading settings and secrets.
 */

const LEGACY_PROVIDER_ID = 'legacy';

function cleanProvider(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || '').trim();
  const baseUrl = String(entry.baseUrl || '').trim();
  if (!id || !baseUrl) return null;
  return {
    id,
    providerId: String(entry.providerId || 'custom').trim() || 'custom',
    name: String(entry.name || '').trim() || id,
    baseUrl,
    model: String(entry.model || '').trim(),
    // A level the API does not know makes it reject the whole request, so only
    // the documented ones survive.
    reasoningEffort: ['low', 'medium', 'high'].includes(entry.reasoningEffort)
      ? entry.reasoningEffort
      : '',
    enabled: entry.enabled !== false,
  };
}

/**
 * Strips a provider list down to the fields that belong in settings.json.
 *
 * The renderer must never be able to persist a key in plaintext: this runs at
 * the IPC write boundary, so an `apiKey` field on an incoming provider is
 * dropped rather than written to disk beside the rest of the settings.
 */
function sanitizeProviderList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const providers = [];
  for (const entry of list) {
    const provider = cleanProvider(entry);
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    providers.push(provider);
  }
  return providers;
}

/** Reads either settings shape and returns the provider list plus the active id. */
function normalizeProviders(ai) {
  const source = ai && typeof ai === 'object' ? ai : {};

  const providers = sanitizeProviderList(source.providers);

  // Only a settings file written *before* the list existed gets migrated. An
  // empty list is a decision — the user removed every provider — and refilling
  // it from the old baseUrl/model brings back a vendor they deleted.
  if (providers.length === 0 && !Array.isArray(source.providers)) {
    // Pre-list settings: one endpoint, one model, one key.
    const legacy = cleanProvider({
      id: LEGACY_PROVIDER_ID,
      providerId: 'custom',
      name: source.name || 'Custom',
      baseUrl: source.baseUrl,
      model: source.model,
      enabled: true,
    });
    if (legacy && legacy.model) providers.push(legacy);
  }

  const requested = String(source.activeProviderId || '').trim();
  const active = providers.some((provider) => provider.id === requested)
    ? requested
    : (providers.find((provider) => provider.enabled)?.id ?? '');

  return { providers, activeProviderId: active };
}

/** The provider a turn should run against, or null when nothing is configured. */
function resolveActiveProvider(ai) {
  const { providers, activeProviderId } = normalizeProviders(ai);
  return providers.find((provider) => provider.id === activeProviderId) ?? null;
}

/**
 * Where a provider's key lives in the secret store. The migrated provider maps
 * to the un-suffixed key so an existing installation keeps working.
 */
function secretKeyForProvider(providerId) {
  const id = String(providerId || '').trim();
  if (!id) return '';
  return id === LEGACY_PROVIDER_ID ? 'apiKey' : `apiKey:${id}`;
}

module.exports = {
  LEGACY_PROVIDER_ID,
  normalizeProviders,
  sanitizeProviderList,
  resolveActiveProvider,
  secretKeyForProvider,
};
