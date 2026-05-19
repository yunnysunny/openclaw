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
export { isEmbeddedPiRunActive, waitForEmbeddedPiRunEnd } from "./pi-embedded-runner/runs.js";
