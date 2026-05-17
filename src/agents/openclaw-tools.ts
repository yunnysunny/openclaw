import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getActiveRuntimeWebToolsMetadata } from "../secrets/runtime.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "./agent-scope.js";
import {
  resolveOpenClawPluginToolsForOptions,
  resolveOpenClawPluginToolsForOptionsAsync,
} from "./openclaw-plugin-tools.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";
import {
  collectPresentOpenClawTools,
  isUpdatePlanToolEnabledForOpenClawTools,
} from "./openclaw-tools.registration.js";
import {
  resolveProviderIdForAuth,
  resolveProviderIdForAuthAsync,
} from "./provider-auth-aliases.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SpawnedToolContext } from "./spawned-context.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createEmbeddedCallGateway } from "./tools/embedded-gateway-stub.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageGenerateTool, resolveImageGenerationModelConfigForToolAsync } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createMusicGenerateTool, resolveMusicGenerationModelConfigForToolAsync } from "./tools/music-generate-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";
import { createVideoGenerateTool, resolveVideoGenerationModelConfigForToolAsync } from "./tools/video-generate-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import type { ToolModelConfig } from "./tools/model-config.helpers.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

type OpenClawToolsDeps = {
  callGateway: typeof callGateway;
  config?: OpenClawConfig;
};

const defaultOpenClawToolsDeps: OpenClawToolsDeps = {
  callGateway,
};

let openClawToolsDeps: OpenClawToolsDeps = defaultOpenClawToolsDeps;

export function createOpenClawTools(
  options?: {
    sandboxBrowserBridgeUrl?: string;
    allowHostBrowserControl?: boolean;
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    /** Delivery target for topic/thread routing. */
    agentTo?: string;
    /** Thread/topic identifier for routing replies to the originating thread. */
    agentThreadId?: string | number;
    agentDir?: string;
    sandboxRoot?: string;
    sandboxContainerWorkdir?: string;
    sandboxFsBridge?: SandboxFsBridge;
    fsPolicy?: ToolFsPolicy;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    pluginToolAllowlist?: string[];
    /** Current channel ID for auto-threading. */
    currentChannelId?: string;
    /** Current thread timestamp for auto-threading. */
    currentThreadTs?: string;
    /** Current inbound message id for action fallbacks. */
    currentMessageId?: string | number;
    /** Reply-to mode for auto-threading. */
    replyToMode?: "off" | "first" | "all" | "batched";
    /** Mutable ref to track if a reply was sent (for "first" mode). */
    hasRepliedRef?: { value: boolean };
    /** If true, the model has native vision capability */
    modelHasVision?: boolean;
    /** Active model provider for provider-specific tool gating. */
    modelProvider?: string;
    /** Active model id for provider/model-specific tool gating. */
    modelId?: string;
    /** If true, nodes action="invoke" can call media-returning commands directly. */
    allowMediaInvokeCommands?: boolean;
    /** Explicit agent ID override for cron/hook sessions. */
    requesterAgentIdOverride?: string;
    /** Require explicit message targets (no implicit last-route sends). */
    requireExplicitMessageTarget?: boolean;
    /** If true, omit the message tool from the tool list. */
    disableMessageTool?: boolean;
    /** If true, skip plugin tool resolution and return only shipped core tools. */
    disablePluginTools?: boolean;
    /** Trusted sender id from inbound context (not tool args). */
    requesterSenderId?: string | null;
    /** Whether the requesting sender is an owner. */
    senderIsOwner?: boolean;
    /** Ephemeral session UUID — regenerated on /new and /reset. */
    sessionId?: string;
    /**
     * Workspace directory to pass to spawned subagents for inheritance.
     * Defaults to workspaceDir. Use this to pass the actual agent workspace when the
     * session itself is running in a copied-workspace sandbox (`ro` or `none`) so
     * subagents inherit the real workspace path instead of the sandbox copy.
     */
    spawnWorkspaceDir?: string;
    /** Callback invoked when sessions_yield tool is called. */
    onYield?: (message: string) => Promise<void> | void;
    /** Allow plugin tools for this tool set to late-bind the gateway subagent. */
    allowGatewaySubagentBinding?: boolean;
    /** Internal: pre-resolved provider id to avoid duplicate normalization work. */
    resolvedModelProviderForPolicy?: string;
    /**
     * When set (including `null`), skips synchronous media-capability resolution for image generation.
     * Used by {@link createOpenClawToolsAsync} to avoid sync fs/manifest work on the async path.
     */
    imageGenerationModelConfig?: ToolModelConfig | null;
    videoGenerationModelConfig?: ToolModelConfig | null;
    musicGenerationModelConfig?: ToolModelConfig | null;
  } & SpawnedToolContext,
): AnyAgentTool[] {
  const resolvedConfig = options?.config ?? openClawToolsDeps.config;
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: options?.agentSessionKey,
    config: resolvedConfig,
    agentId: options?.requesterAgentIdOverride,
  });
  // Fall back to the session agent workspace so plugin loading stays workspace-stable
  // even when a caller forgets to thread workspaceDir explicitly.
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const spawnWorkspaceDir = resolveWorkspaceRoot(
    options?.spawnWorkspaceDir ?? options?.workspaceDir ?? inferredWorkspaceDir,
  );
  const normalizedModelProvider =
    typeof options?.resolvedModelProviderForPolicy === "string"
      ? options.resolvedModelProviderForPolicy
      : typeof options?.modelProvider === "string" && options.modelProvider.trim()
        ? resolveProviderIdForAuth(options.modelProvider, {
            config: resolvedConfig,
            workspaceDir,
          })
        : options?.modelProvider;
  if (
    typeof options?.resolvedModelProviderForPolicy !== "string" &&
    typeof options?.modelProvider === "string" &&
    options.modelProvider.trim()
  ) {
    void resolveProviderIdForAuthAsync(options.modelProvider, {
      config: resolvedConfig,
      workspaceDir,
    });
  }
  const deliveryContext = normalizeDeliveryContext({
    channel: options?.agentChannel,
    to: options?.agentTo,
    accountId: options?.agentAccountId,
    threadId: options?.agentThreadId,
  });
  const runtimeWebTools = getActiveRuntimeWebToolsMetadata();
  const sandbox =
    options?.sandboxRoot && options?.sandboxFsBridge
      ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
      : undefined;
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const imageGenerateTool = createImageGenerateTool({
    config: options?.config,
    agentDir: options?.agentDir,
    workspaceDir,
    sandbox,
    fsPolicy: options?.fsPolicy,
    imageGenerationModelConfig: options?.imageGenerationModelConfig,
  });
  const videoGenerateTool = createVideoGenerateTool({
    config: options?.config,
    agentDir: options?.agentDir,
    agentSessionKey: options?.agentSessionKey,
    requesterOrigin: deliveryContext ?? undefined,
    workspaceDir,
    sandbox,
    fsPolicy: options?.fsPolicy,
    videoGenerationModelConfig: options?.videoGenerationModelConfig,
  });
  const musicGenerateTool = createMusicGenerateTool({
    config: options?.config,
    agentDir: options?.agentDir,
    agentSessionKey: options?.agentSessionKey,
    requesterOrigin: deliveryContext ?? undefined,
    workspaceDir,
    sandbox,
    fsPolicy: options?.fsPolicy,
    musicGenerationModelConfig: options?.musicGenerationModelConfig,
  });
  const pdfTool = options?.agentDir?.trim()
    ? createPdfTool({
        config: options?.config,
        agentDir: options.agentDir,
        workspaceDir,
        sandbox,
        fsPolicy: options?.fsPolicy,
      })
    : null;
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
    runtimeWebSearch: runtimeWebTools?.search,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
    runtimeWebFetch: runtimeWebTools?.fetch,
  });
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        sessionId: options?.sessionId,
        config: options?.config,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        currentMessageId: options?.currentMessageId,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        requesterSenderId: options?.requesterSenderId ?? undefined,
        senderIsOwner: options?.senderIsOwner,
      });
  const nodesToolBase = createNodesTool({
    agentSessionKey: options?.agentSessionKey,
    agentChannel: options?.agentChannel,
    agentAccountId: options?.agentAccountId,
    currentChannelId: options?.currentChannelId,
    currentThreadTs: options?.currentThreadTs,
    config: options?.config,
    modelHasVision: options?.modelHasVision,
    allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
  });
  const nodesTool = applyNodesToolWorkspaceGuard(nodesToolBase, {
    fsPolicy: options?.fsPolicy,
    sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
    sandboxRoot: options?.sandboxRoot,
    workspaceDir,
  });
  const embedded = isEmbeddedMode();
  const effectiveCallGateway = embedded
    ? createEmbeddedCallGateway()
    : openClawToolsDeps.callGateway;
  const tools: AnyAgentTool[] = [
    ...(embedded
      ? []
      : [
          createCanvasTool({ config: options?.config }),
          nodesTool,
          createCronTool({
            agentSessionKey: options?.agentSessionKey,
          }),
        ]),
    ...(!embedded && messageTool ? [messageTool] : []),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: resolvedConfig,
    }),
    ...collectPresentOpenClawTools([imageGenerateTool, musicGenerateTool, videoGenerateTool]),
    ...(embedded
      ? []
      : [
          createGatewayTool({
            agentSessionKey: options?.agentSessionKey,
            config: options?.config,
          }),
        ]),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    ...(isUpdatePlanToolEnabledForOpenClawTools({
      config: resolvedConfig,
      agentSessionKey: options?.agentSessionKey,
      agentId: options?.requesterAgentIdOverride,
      modelProvider: normalizedModelProvider,
      modelId: options?.modelId,
    })
      ? [createUpdatePlanTool()]
      : []),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: effectiveCallGateway,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: resolvedConfig,
      callGateway: effectiveCallGateway,
    }),
    ...(embedded
      ? []
      : [
          createSessionsSendTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            sandboxed: options?.sandboxed,
            config: resolvedConfig,
            callGateway: openClawToolsDeps.callGateway,
          }),
          createSessionsSpawnTool({
            agentSessionKey: options?.agentSessionKey,
            agentChannel: options?.agentChannel,
            agentAccountId: options?.agentAccountId,
            agentTo: options?.agentTo,
            agentThreadId: options?.agentThreadId,
            agentGroupId: options?.agentGroupId,
            agentGroupChannel: options?.agentGroupChannel,
            agentGroupSpace: options?.agentGroupSpace,
            agentMemberRoleIds: options?.agentMemberRoleIds,
            sandboxed: options?.sandboxed,
            requesterAgentIdOverride: options?.requesterAgentIdOverride,
            workspaceDir: spawnWorkspaceDir,
          }),
        ]),
    createSessionsYieldTool({
      sessionId: options?.sessionId,
      onYield: options?.onYield,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: resolvedConfig,
      sandboxed: options?.sandboxed,
    }),
    ...collectPresentOpenClawTools([webSearchTool, webFetchTool, imageTool, pdfTool]),
  ];

  if (options?.disablePluginTools) {
    return tools;
  }

  const wrappedPluginTools = resolveOpenClawPluginToolsForOptions({
    options,
    resolvedConfig,
    existingToolNames: new Set(tools.map((tool) => tool.name)),
  });

  return [...tools, ...wrappedPluginTools];
}

export async function createOpenClawToolsAsync(
  options?: Parameters<typeof createOpenClawTools>[0],
): Promise<AnyAgentTool[]> {
  const resolvedConfig = options?.config ?? openClawToolsDeps.config;
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: options?.agentSessionKey,
    config: resolvedConfig,
    agentId: options?.requesterAgentIdOverride,
  });
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const normalizedModelProvider =
    typeof options?.modelProvider === "string" && options.modelProvider.trim()
      ? await resolveProviderIdForAuthAsync(options.modelProvider, {
          config: resolvedConfig,
          workspaceDir,
        })
      : options?.modelProvider;

  const [imageModelCfg, videoModelCfg, musicModelCfg] = await Promise.all([
    resolveImageGenerationModelConfigForToolAsync({
      cfg: resolvedConfig,
      agentDir: options?.agentDir,
    }),
    resolveVideoGenerationModelConfigForToolAsync({
      cfg: resolvedConfig,
      agentDir: options?.agentDir,
    }),
    resolveMusicGenerationModelConfigForToolAsync({
      cfg: resolvedConfig,
      agentDir: options?.agentDir,
    }),
  ]);

  const coreTools = createOpenClawTools({
    ...options,
    disablePluginTools: true,
    modelProvider: normalizedModelProvider,
    resolvedModelProviderForPolicy: normalizedModelProvider,
    imageGenerationModelConfig: imageModelCfg,
    videoGenerationModelConfig: videoModelCfg,
    musicGenerationModelConfig: musicModelCfg,
  });
  if (options?.disablePluginTools) {
    return coreTools;
  }

  const wrappedPluginTools = await resolveOpenClawPluginToolsForOptionsAsync({
    options: {
      ...options,
      modelProvider: normalizedModelProvider,
    },
    resolvedConfig,
    existingToolNames: new Set(coreTools.map((tool) => tool.name)),
  });

  return [...coreTools, ...wrappedPluginTools];
}

export const __testing = {
  setDepsForTest(overrides?: Partial<OpenClawToolsDeps>) {
    openClawToolsDeps = overrides
      ? {
          ...defaultOpenClawToolsDeps,
          ...overrides,
        }
      : defaultOpenClawToolsDeps;
  },
};
