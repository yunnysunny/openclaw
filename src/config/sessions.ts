export * from "./sessions/combined-store-gateway.js";
export * from "./sessions/group.js";
export * from "./sessions/artifacts.js";
export * from "./sessions/metadata.js";
export * from "./sessions/main-session.js";
export * from "./sessions/main-session.runtime.js";
export * from "./sessions/lifecycle.js";
export * from "./sessions/paths.js";
export * from "./sessions/reset.js";
export * from "./sessions/session-key.js";
export * from "./sessions/store.js";
export * from "./sessions/types.js";
export * from "./sessions/transcript.js";
export * from "./sessions/session-file.js";
export * from "./sessions/session-file-rotation.js";
export * from "./sessions/delivery-info.js";
export * from "./sessions/disk-budget.js";
export * from "./sessions/targets.js";

export async function readLatestAssistantTextFromSessionTranscript(
  _sessionFile: string,
): Promise<{ text: string } | undefined> {
  return undefined;
}

export { purgeAgentSessionStoreEntries } from "./sessions/cleanup-service.js";
export {
  resolveSessionCleanupAction,
  runSessionsCleanup,
  serializeSessionCleanupResult,
} from "./sessions/cleanup-service.js";
