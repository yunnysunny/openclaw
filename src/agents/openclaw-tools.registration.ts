import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isStrictAgenticExecutionContractActive } from "./execution-contract.js";
import { expandToolGroups, normalizeToolList } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

export function collectPresentOpenClawTools(
  candidates: readonly (AnyAgentTool | null | undefined)[],
): AnyAgentTool[] {
  return candidates.filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
}

export function isUpdatePlanToolEnabledForOpenClawTools(params: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
  runtimeToolAllowlist?: string[];
  runtimeToolDenylist?: string[];
}): boolean {
  const configured = params.config?.tools?.experimental?.planTool;
  if (configured !== undefined) {
    return configured;
  }
  if (isOpenClawToolDenied("update_plan", params.runtimeToolDenylist)) {
    return false;
  }
  if (
    isOpenClawToolAllowed("update_plan", params.runtimeToolAllowlist) ||
    isOpenClawToolAllowed("update_plan", params.config?.tools?.allow) ||
    isOpenClawToolAllowed("update_plan", params.config?.tools?.alsoAllow)
  ) {
    return true;
  }
  return isStrictAgenticExecutionContractActive({
    config: params.config,
    sessionKey: params.agentSessionKey,
    agentId: params.agentId,
    provider: params.modelProvider,
    modelId: params.modelId,
  });
}

export function isOpenClawToolAllowed(toolName: string, allowlist?: string[]): boolean {
  const normalizedAllow = normalizeToolList(allowlist);
  return normalizedAllow.includes("*") || expandToolGroups(normalizedAllow).includes(toolName);
}

export function isOpenClawToolDenied(toolName: string, denylist?: string[]): boolean {
  return expandToolGroups(normalizeToolList(denylist)).includes(toolName);
}
