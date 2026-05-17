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

