import {
  listKnownProviderAuthEnvVarNames,
  resolveProviderAuthEnvVarCandidates,
  resolveProviderAuthEnvVarCandidatesAsync,
} from "../secrets/provider-env-vars.js";
import type { ProviderEnvVarLookupParams } from "../secrets/provider-env-vars.js";

export function resolveProviderEnvApiKeyCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return resolveProviderAuthEnvVarCandidates(params);
}

export async function resolveProviderEnvApiKeyCandidatesAsync(
  params?: ProviderEnvVarLookupParams,
): Promise<Record<string, readonly string[]>> {
  return resolveProviderAuthEnvVarCandidatesAsync(params);
}

export const PROVIDER_ENV_API_KEY_CANDIDATES = resolveProviderEnvApiKeyCandidates();

export function listKnownProviderEnvApiKeyNames(): string[] {
  return listKnownProviderAuthEnvVarNames();
}

// Stage 4 compat stubs: upstream-only auth-env lookup helpers.
// Locally provider auth resolution doesn't drive evidence collection through
// these helpers; return empty so callers report "no env evidence" without
// surfacing partial state, and tests that expect mocking can swap them out.
export function listProviderEnvAuthLookupKeys(_params?: unknown): string[] {
  return [];
}
export function resolveProviderEnvAuthEvidence(_params?: unknown): unknown[] {
  return [];
}
