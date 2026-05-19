// @ts-nocheck
export { getRuntimeConfig } from "../config/config.js";
export {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
export { callGateway } from "../gateway/call.js";
// Stage 5: lazy require to avoid the static import cycle through
// gateway/server-plugins.ts. Both surfaces are async stubs locally.
export const dispatchGatewayMethodInProcess: (
  ...args: unknown[]
) => Promise<unknown> = async (...args) => {
  const mod = await import("../gateway/server-plugins.js");
  return mod.dispatchGatewayMethodInProcess(...args);
};
export { resolveQueueSettings } from "../auto-reply/reply/queue.js";
export { resolveExternalBestEffortDeliveryTarget } from "../infra/outbound/best-effort-delivery.js";
export { sendMessage } from "../infra/outbound/message.js";
export { createBoundDeliveryRouter } from "../infra/outbound/bound-delivery-router.js";
export { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
export { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
export {
  formatEmbeddedPiQueueFailureSummary,
  isEmbeddedPiRunActive,
  queueEmbeddedPiMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "./pi-embedded-runner/runs.js";
