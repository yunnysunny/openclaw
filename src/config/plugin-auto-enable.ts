export {
  applyPluginAutoEnable,
  applyPluginAutoEnableAsync,
  materializePluginAutoEnableCandidates,
  materializePluginAutoEnableCandidatesAsync,
} from "./plugin-auto-enable.apply.js";
export {
  detectPluginAutoEnableCandidates,
  detectPluginAutoEnableCandidatesAsync,
} from "./plugin-auto-enable.detect.js";
export type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
export {
  resolveConfiguredPluginAutoEnableCandidates,
  resolveConfiguredPluginAutoEnableCandidatesAsync,
  resolvePluginAutoEnableCandidateReason,
  resolvePluginAutoEnableManifestRegistryAsync,
} from "./plugin-auto-enable.shared.js";
export {
  resolvePluginSetupAutoEnableReasons,
  resolvePluginSetupAutoEnableReasonsAsync,
} from "../plugins/setup-registry.js";
