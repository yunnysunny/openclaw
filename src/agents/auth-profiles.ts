// @ts-nocheck
export { CLAUDE_CLI_PROFILE_ID, CODEX_CLI_PROFILE_ID } from "./auth-profiles/constants.js";
export type {
  AuthCredentialReasonCode,
  TokenExpiryState,
} from "./auth-profiles/credential-state.js";
export type { AuthProfileEligibilityReasonCode } from "./auth-profiles/order.js";
export { resolveAuthProfileDisplayLabel } from "./auth-profiles/display.js";
export { formatAuthDoctorHint } from "./auth-profiles/doctor.js";
export { resolveApiKeyForProfile } from "./auth-profiles/oauth.js";
export { resolveAuthProfileEligibility, resolveAuthProfileOrder } from "./auth-profiles/order.js";
export {
  resolveAuthStatePathForDisplay,
  resolveAuthStorePathForDisplay,
} from "./auth-profiles/paths.js";
export {
  dedupeProfileIds,
  listProfilesForProvider,
  listProfilesForProviderAsync,
  markAuthProfileGood,
  setAuthProfileOrder,
  upsertAuthProfile,
  upsertAuthProfileWithLock,
} from "./auth-profiles/profiles.js";
export {
  repairOAuthProfileIdMismatch,
  suggestOAuthProfileIdForLegacyDefault,
} from "./auth-profiles/repair.js";
export {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  ensureAuthProfileStoreWithoutExternalProfiles,
  hasAnyAuthProfileStoreSource,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStore,
  saveAuthProfileStore,
  saveAuthProfileStoreAsync,
} from "./auth-profiles/store.js";
export type {
  ApiKeyCredential,
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileIdRepairResult,
  AuthProfileState,
  AuthProfileStore,
  OAuthCredential,
  ProfileUsageStats,
  TokenCredential,
} from "./auth-profiles/types.js";
export {
  calculateAuthProfileCooldownMs,
  clearAuthProfileCooldown,
  clearExpiredCooldowns,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  markAuthProfileBlockedUntil,
  markAuthProfileCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntilForDisplay,
} from "./auth-profiles/usage.js";
export type { ExternalAuthProfileMap } from "./auth-profiles/external-auth.js";
export {
  listRuntimeExternalAuthProfileMap,
  listRuntimeExternalAuthProfileMapAsync,
  listRuntimeExternalAuthProfilesAsync,
  overlayExternalAuthProfilesAsync,
  resolveExternalAuthProfileMap,
  resolveExternalAuthProfileMapAsync,
  shouldPersistExternalAuthProfileAsync,
} from "./auth-profiles/external-auth.js";

// Compat stubs (post Stage 3 merge): upstream renamed/removed.
export function findPersistedAuthProfileCredential(_params: unknown): undefined {
  return undefined;
}
export function resolvePersistedAuthProfileOwnerAgentDir(_params: unknown): undefined {
  return undefined;
}


// Stage 4 compat stubs.
export async function refreshOAuthCredentialForRuntime(_params: unknown): Promise<undefined> {
  return undefined;
}
export type AuthProfileBlockedReason = string;
export type AuthProfileBlockedSource = string;

// Stage 4 compat re-export: upstream lifted external CLI discovery onto the
// auth-profiles barrel; mirror the underlying helper here so callers using the
// new path keep resolving without rewiring their imports.
export { externalCliDiscoveryForProviderAuth } from "./auth-profiles/external-cli-discovery.js";


// Stage 4 compat re-export: portability helper used by agent copy flows.
export { buildPortableAuthProfileSecretsStoreForAgentCopy } from "./auth-profiles/portability.js";

// Stage 4 compat re-export: status-shaped CLI discovery helper.
export { externalCliDiscoveryForConfigStatus } from "./auth-profiles/external-cli-discovery.js";

// Stage 4 compat stub: upstream-only bulk profile remover with the auth lock.
// Locally lmstudio setup runs under the same lock; emulate by calling
// upsertAuthProfileWithLock with an empty profile list (no-op) — the tests
// mock this entirely and don't depend on the implementation.
export async function removeProviderAuthProfilesWithLock(_params: {
  agentDir: string;
  provider: string;
  profileIds?: string[];
}): Promise<void> {
  // intentionally no-op
}

// Stage 4 compat re-export: scoped CLI discovery used by models list probes.
export { externalCliDiscoveryScoped } from "./auth-profiles/external-cli-discovery.js";

// Stage 4 compat stub: upstream-only AWS SDK profile classifier.
// Locally directive-handling.auth treats AWS as a regular API-key path; return
// false so the AWS SDK branch isn't taken.
export function isConfiguredAwsSdkAuthProfileForProvider(_params: {
  cfg?: unknown;
  provider?: string;
  profileId?: string;
}): boolean {
  return false;
}
