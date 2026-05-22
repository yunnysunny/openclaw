// @ts-nocheck
import type { CliDeps } from "../cli/deps.types.js";
import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredInternalHooks } from "../hooks/configured.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { hasRestartSentinel } from "../infra/restart-sentinel.js";
import type { scheduleGatewayUpdateCheck } from "../infra/update-startup.js";
import type { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import type { logGatewayStartup } from "./server-startup-log.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./server-startup-unavailable-methods.js";
import type { startGatewayTailscaleExposure } from "./server-tailscale.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;
const PRIMARY_MODEL_PREWARM_TIMEOUT_MS = 10_000;
const QMD_STARTUP_IDLE_DELAY_MS = 120_000;

type Awaitable<T> = T | Promise<T>;
type GatewayPostReadySidecarHandle = { stop: () => void };

type GatewayStartupTrace = {
  mark: (name: string) => void;
  detail?: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  measure: <T>(name: string, run: () => Awaitable<T>) => Promise<T>;
};

async function measureStartup<T>(
  startupTrace: GatewayStartupTrace | undefined,
  name: string,
  run: () => Awaitable<T>,
): Promise<T> {
  return startupTrace ? startupTrace.measure(name, run) : await run();
}

function shouldCheckRestartSentinel(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.VITEST && env.NODE_ENV !== "test";
}

function shouldStartGatewayMemoryBackend(cfg: OpenClawConfig): boolean {
  return cfg.memory?.backend === "qmd";
}

function resolveGatewayMemoryStartupPolicy(
  cfg: OpenClawConfig,
): { mode: "off" } | { mode: "immediate" } | { mode: "idle"; delayMs: number } {
  if (!shouldStartGatewayMemoryBackend(cfg)) {
    return { mode: "off" };
  }
  const update = cfg.memory?.qmd?.update;
  if (update?.onBoot === false || update?.startup === undefined || update.startup === "off") {
    return { mode: "off" };
  }
  if (update.startup === "immediate") {
    return { mode: "immediate" };
  }
  if (update.startup === "idle") {
    const delayMs =
      typeof update.startupDelayMs === "number" && Number.isFinite(update.startupDelayMs)
        ? Math.max(0, Math.floor(update.startupDelayMs))
        : QMD_STARTUP_IDLE_DELAY_MS;
    return { mode: "idle", delayMs };
  }
  return { mode: "off" };
}

function isConfiguredCliBackendPrimary(params: {
  cfg: OpenClawConfig;
  explicitPrimary: string;
  normalizeProviderId: (provider: string) => string;
}): boolean {
  const slashIndex = params.explicitPrimary.indexOf("/");
  if (slashIndex <= 0) {
    return false;
  }
  const provider = params.normalizeProviderId(params.explicitPrimary.slice(0, slashIndex));
  return Object.keys(params.cfg.agents?.defaults?.cliBackends ?? {}).some(
    (backend) => params.normalizeProviderId(backend) === provider,
  );
}

async function hasGatewayStartupInternalHookListeners(): Promise<boolean> {
  const { hasInternalHookListeners } = await import("../hooks/internal-hooks.js");
  return hasInternalHookListeners("gateway", "startup");
}

async function hasRestartSentinelFileFast(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return await hasRestartSentinel(env);
}

async function refreshLatestUpdateRestartSentinelIfPresent(): Promise<unknown | null> {
  if (!(await hasRestartSentinelFileFast())) {
    return null;
  }
  const { refreshLatestUpdateRestartSentinel } = await import("./server-restart-sentinel.js");
  return await refreshLatestUpdateRestartSentinel();
}

async function prewarmConfiguredPrimaryModel(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  log: { warn: (msg: string) => void };
}): Promise<void> {
  const { resolveAgentModelPrimaryValue } = await import("../config/model-input.js");
  const explicitPrimary = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)?.trim();
  if (!explicitPrimary) {
    return;
  }
  const { normalizeProviderId } = await import("../agents/provider-id.js");
  if (
    isConfiguredCliBackendPrimary({
      cfg: params.cfg,
      explicitPrimary,
      normalizeProviderId,
    })
  ) {
    return;
  }
  const [
    { resolveDefaultAgentDir },
    { DEFAULT_MODEL, DEFAULT_PROVIDER },
    { selectAgentHarness },
    { isCliProvider, resolveConfiguredModelRef },
    { ensureOpenClawModelsJson },
    { resolveModel, resolveModelAsync },
    { resolveEmbeddedAgentRuntime },
  ] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../agents/defaults.js"),
    import("../agents/harness/selection.js"),
    import("../agents/model-selection.js"),
    import("../agents/models-config.js"),
    import("../agents/pi-embedded-runner/model.js"),
    import("../agents/pi-embedded-runner/runtime.js"),
  ]);
  const { provider, model } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  if (isCliProvider(provider, params.cfg)) {
    return;
  }
  const runtime = resolveEmbeddedAgentRuntime();
  if (runtime !== "auto" && runtime !== "pi") {
    return;
  }
  if (selectAgentHarness({ provider, modelId: model, config: params.cfg }).id !== "pi") {
    return;
  }
  const agentDir = resolveDefaultAgentDir(params.cfg);
  try {
    await ensureOpenClawModelsJson(params.cfg, agentDir, {
      workspaceDir: params.workspaceDir,
      providerDiscoveryProviderIds: [provider],
    });
    const resolved = resolveModel(provider, model, agentDir, params.cfg, {
      skipProviderRuntimeHooks: true,
    });
    if (!resolved.model) {
      const asyncResolved = await resolveModelAsync(provider, model, agentDir, params.cfg);
      if (!asyncResolved.model) {
        throw new Error(
          resolved.error ?? asyncResolved.error ?? `Unknown model: ${provider}/${model}`,
        );
      }
    }
  } catch (err) {
    params.log.warn(`startup model warmup failed for ${provider}/${model}: ${String(err)}`);
  }
}

async function prewarmConfiguredPrimaryModelWithTimeout(
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    log: { warn: (msg: string) => void };
    timeoutMs?: number;
  },
  prewarm: typeof prewarmConfiguredPrimaryModel = prewarmConfiguredPrimaryModel,
): Promise<void> {
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(0, Math.floor(params.timeoutMs))
      : PRIMARY_MODEL_PREWARM_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const prewarmPromise = Promise.resolve(prewarm(params)).catch((err) => {
    if (!timedOut) {
      throw err;
    }
  });
  try {
    await Promise.race([
      prewarmPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          params.log.warn(
            `startup model warmup timed out after ${timeoutMs}ms; continuing without waiting`,
          );
          resolve();
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function runPostReadySidecar(params: {
  label: string;
  log: { warn: (msg: string) => void };
  run: (signal: AbortSignal, isCancelled: () => boolean) => Promise<void>;
}): GatewayPostReadySidecarHandle {
  const abortController = new AbortController();
  let started = false;
  setImmediate(() => {
    started = true;
    if (abortController.signal.aborted) {
      return;
    }
    void params
      .run(abortController.signal, () => abortController.signal.aborted)
      .catch((err) => {
        if (!abortController.signal.aborted) {
          params.log.warn(`${params.label} failed after gateway ready: ${String(err)}`);
        }
      });
  });
  return {
    stop() {
      if (!started || !abortController.signal.aborted) {
        abortController.abort();
      }
    },
  };
}

function stopPostReadySidecarsAfterCloseStarted(params: {
  postReadySidecars: readonly GatewayPostReadySidecarHandle[];
  closeStarted: boolean;
}): void {
  if (!params.closeStarted) {
    return;
  }
  for (const sidecar of params.postReadySidecars) {
    sidecar.stop();
  }
}

export async function startGatewaySidecars(params: {
  cfg: OpenClawConfig;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  startupTrace?: GatewayStartupTrace;
  prewarmPrimaryModel?: typeof prewarmConfiguredPrimaryModel;
}) {
  const postReadySidecars: GatewayPostReadySidecarHandle[] = [];
  await measureStartup(params.startupTrace, "sidecars.session-locks", async () => {
    try {
      const [{ resolveStateDir }, { resolveAgentSessionDirs }, { cleanStaleLockFiles }] =
        await Promise.all([
          import("../config/paths.js"),
          import("../agents/session-dirs.js"),
          import("../agents/session-write-lock.js"),
        ]);
      const stateDir = resolveStateDir(process.env);
      const sessionDirs = await resolveAgentSessionDirs(stateDir);
      for (const sessionsDir of sessionDirs) {
        const result = await cleanStaleLockFiles({
          sessionsDir,
          staleMs: SESSION_LOCK_STALE_MS,
          removeStale: true,
          log: { warn: (message) => params.log.warn(message) },
        });
        if (result.cleaned.length > 0) {
          const { markRestartAbortedMainSessionsFromLocks } =
            await import("../agents/main-session-restart-recovery.js");
          await markRestartAbortedMainSessionsFromLocks({
            sessionsDir,
            cleanedLocks: result.cleaned,
          });
        }
      }
    } catch (err) {
      params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
    }
  });

  await measureStartup(params.startupTrace, "sidecars.gmail-watch-register", async () => {
    if (params.cfg.hooks?.enabled && params.cfg.hooks.gmail?.account) {
      postReadySidecars.push(
        runPostReadySidecar({
          label: "sidecars.gmail-watch",
          log: params.log,
          run: async (signal, isCancelled) => {
            const { startGmailWatcherWithLogs } = await import(
              "../hooks/gmail-watcher-lifecycle.js"
            );
            if (signal.aborted) {
              return;
            }
            await startGmailWatcherWithLogs({
              cfg: params.cfg,
              log: params.logHooks,
              isCancelled,
              signal,
            });
          },
        }),
      );
    }
  });

  await measureStartup(params.startupTrace, "sidecars.gmail-model-register", async () => {
    if (params.cfg.hooks?.gmail?.model) {
      postReadySidecars.push(
        runPostReadySidecar({
          label: "sidecars.gmail-model",
          log: params.log,
          run: async (signal) => {
            const [
              { DEFAULT_MODEL, DEFAULT_PROVIDER },
              { loadModelCatalog },
              { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel },
            ] = await Promise.all([
              import("../agents/defaults.js"),
              import("../agents/model-catalog.js"),
              import("../agents/model-selection.js"),
            ]);
            if (signal.aborted) {
              return;
            }
            const hooksModelRef = resolveHooksGmailModel({
              cfg: params.cfg,
              defaultProvider: DEFAULT_PROVIDER,
            });
            if (hooksModelRef) {
              const { provider: resolvedDefaultProvider, model: defaultModel } =
                resolveConfiguredModelRef({
                  cfg: params.cfg,
                  defaultProvider: DEFAULT_PROVIDER,
                  defaultModel: DEFAULT_MODEL,
                });
              const catalog = await loadModelCatalog({ config: params.cfg });
              const status = getModelRefStatus({
                cfg: params.cfg,
                catalog,
                ref: hooksModelRef,
                defaultProvider: resolvedDefaultProvider,
                defaultModel,
              });
              if (!status.allowed) {
                params.logHooks.warn(
                  `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
                );
              }
              if (!status.inCatalog) {
                params.logHooks.warn(
                  `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
                );
              }
            }
          },
        }),
      );
    }
  });

  const internalHooksConfigured = hasConfiguredInternalHooks(params.cfg);
  await measureStartup(params.startupTrace, "sidecars.internal-hooks", async () => {
    try {
      if (internalHooksConfigured) {
        const [{ setInternalHooksEnabled }, { loadInternalHooks }] = await Promise.all([
          import("../hooks/internal-hooks.js"),
          import("../hooks/loader.js"),
        ]);
        setInternalHooksEnabled(params.cfg.hooks?.internal?.enabled !== false);
        const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
        if (loadedCount > 0) {
          params.logHooks.info(
            `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
          );
        }
      }
    } catch (err) {
      params.logHooks.error(`failed to load hooks: ${String(err)}`);
    }
  });

  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  await measureStartup(params.startupTrace, "sidecars.channels", async () => {
    if (!skipChannels) {
      try {
        void prewarmConfiguredPrimaryModelWithTimeout(
          {
            cfg: params.cfg,
            workspaceDir: params.defaultWorkspaceDir,
            log: params.log,
          },
          params.prewarmPrimaryModel ?? prewarmConfiguredPrimaryModel,
        ).catch((err) => {
          params.log.warn(`startup model warmup failed: ${String(err)}`);
        });
        await params.startChannels();
      } catch (err) {
        params.logChannels.error(`channel startup failed: ${String(err)}`);
      }
    } else {
      await measureStartup(params.startupTrace, "sidecars.channel-skip", () => {
        params.logChannels.info(
          "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
        );
      });
    }
  });

  const shouldDispatchGatewayStartupInternalHook =
    internalHooksConfigured || (await hasGatewayStartupInternalHookListeners());
  if (shouldDispatchGatewayStartupInternalHook) {
    setTimeout(() => {
      void import("../hooks/internal-hooks.js").then(
        ({ createInternalHookEvent, triggerInternalHook }) => {
          const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
            cfg: params.cfg,
            deps: params.deps,
            workspaceDir: params.defaultWorkspaceDir,
          });
          void triggerInternalHook(hookEvent);
        },
      );
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  await measureStartup(params.startupTrace, "sidecars.plugin-services", async () => {
    try {
      const { startPluginServices } = await import("../plugins/services.js");
      pluginServices = await startPluginServices({
        registry: params.pluginRegistry,
        config: params.cfg,
        workspaceDir: params.defaultWorkspaceDir,
      });
    } catch (err) {
      params.log.warn(`plugin services failed to start: ${String(err)}`);
    }
  });

  if (params.cfg.acp?.enabled) {
    postReadySidecars.push(
      runPostReadySidecar({
        label: "sidecars.acp.identity-reconcile",
        log: params.log,
        run: async (signal) => {
          const [{ getAcpRuntimeBackend }, { getAcpSessionManager }] = await Promise.all([
            import("../acp/runtime/registry.js"),
            import("../acp/control-plane/manager.js"),
          ]);
          await measureStartup(params.startupTrace, "sidecars.acp.runtime-ready", async () => {
            while (!signal.aborted) {
              const backend = getAcpRuntimeBackend(params.cfg.acp?.backend);
              if (backend?.healthy?.() === true) {
                params.startupTrace?.detail?.("sidecars.acp.runtime-ready", [
                  ["readyCount", 1],
                  ["backend", String(backend.id ?? params.cfg.acp?.backend ?? "")],
                ]);
                return;
              }
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 25);
                timer.unref?.();
              });
            }
          });
          if (signal.aborted) {
            return;
          }
          await measureStartup(params.startupTrace, "sidecars.acp.identity-reconcile", async () => {
            const result = await getAcpSessionManager().reconcilePendingSessionIdentities({
              cfg: params.cfg,
            });
            if (result.checked === 0) {
              return;
            }
            const { ACP_SESSION_IDENTITY_RENDERER_VERSION } = await import(
              "../acp/runtime/session-identifiers.js"
            );
            params.log.warn(
              `acp startup identity reconcile (renderer=${ACP_SESSION_IDENTITY_RENDERER_VERSION}): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`,
            );
          });
        },
      }),
    );
  }

  await measureStartup(params.startupTrace, "sidecars.memory", async () => {
    const policy = resolveGatewayMemoryStartupPolicy(params.cfg);
    if (policy.mode === "off") {
      return;
    }
    const start = () => {
      void import("./server-startup-memory.js")
        .then(({ startGatewayMemoryBackend }) =>
          startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }),
        )
        .catch((err) => {
          params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
        });
    };
    if (policy.mode === "idle") {
      const timer = setTimeout(start, policy.delayMs);
      timer.unref?.();
      return;
    }
    setImmediate(start);
  });

  await measureStartup(params.startupTrace, "sidecars.restart-sentinel", async () => {
    if (!shouldCheckRestartSentinel()) {
      return;
    }
    if (!(await hasRestartSentinelFileFast())) {
      return;
    }
    setTimeout(() => {
      void import("./server-restart-sentinel.js")
        .then(({ scheduleRestartSentinelWake }) =>
          scheduleRestartSentinelWake({ deps: params.deps }),
        )
        .catch((err) => {
          params.log.warn(`restart sentinel wake failed to schedule: ${String(err)}`);
        });
    }, 750);
  });

  await measureStartup(params.startupTrace, "sidecars.subagent-recovery", async () => {
    const { scheduleSubagentOrphanRecovery } = await import("../agents/subagent-registry.js");
    scheduleSubagentOrphanRecovery();
  });

  await measureStartup(params.startupTrace, "sidecars.main-session-recovery", async () => {
    const { scheduleRestartAbortedMainSessionRecovery } =
      await import("../agents/main-session-restart-recovery.js");
    scheduleRestartAbortedMainSessionRecovery();
  });

  return { pluginServices, postReadySidecars };
}

type GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner: () => Awaitable<ReturnType<typeof getGlobalHookRunner>>;
  logGatewayStartup: (params: Parameters<typeof logGatewayStartup>[0]) => Awaitable<void>;
  scheduleGatewayUpdateCheck: (
    ...args: Parameters<typeof scheduleGatewayUpdateCheck>
  ) => Awaitable<ReturnType<typeof scheduleGatewayUpdateCheck>>;
  startGatewaySidecars: typeof startGatewaySidecars;
  startGatewayTailscaleExposure: (
    ...args: Parameters<typeof startGatewayTailscaleExposure>
  ) => ReturnType<typeof startGatewayTailscaleExposure>;
  refreshLatestUpdateRestartSentinel: () => Awaitable<unknown | null>;
};

const defaultGatewayPostAttachRuntimeDeps: GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner: async () =>
    (await import("../plugins/hook-runner-global.js")).getGlobalHookRunner(),
  logGatewayStartup: async (params) =>
    (await import("./server-startup-log.js")).logGatewayStartupAsync(params),
  scheduleGatewayUpdateCheck: async (...args) =>
    (await import("../infra/update-startup.js")).scheduleGatewayUpdateCheck(...args),
  startGatewaySidecars,
  startGatewayTailscaleExposure: async (...args) =>
    (await import("./server-tailscale.js")).startGatewayTailscaleExposure(...args),
  refreshLatestUpdateRestartSentinel: refreshLatestUpdateRestartSentinelIfPresent,
};

export async function startGatewayPostAttachRuntime(
  params: {
    minimalTestGateway: boolean;
    cfgAtStart: OpenClawConfig;
    bindHost: string;
    bindHosts: string[];
    port: number;
    tlsEnabled: boolean;
    log: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
    };
    isNixMode: boolean;
    startupStartedAt?: number;
    broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
    tailscaleMode: GatewayTailscaleMode;
    resetOnExit: boolean;
    controlUiBasePath: string;
    logTailscale: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    };
    gatewayPluginConfigAtStart: OpenClawConfig;
    pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
    defaultWorkspaceDir: string;
    deps: CliDeps;
    startChannels: () => Promise<void>;
    logHooks: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
    logChannels: { info: (msg: string) => void; error: (msg: string) => void };
    unavailableGatewayMethods: Set<string>;
    onPluginServices?: (pluginServices: PluginServicesHandle | null) => void;
    onPostReadySidecars?: (postReadySidecars: GatewayPostReadySidecarHandle[]) => void;
    onSidecarsReady?: () => void;
    startupTrace?: GatewayStartupTrace;
    deferSidecars?: boolean;
    loadStartupPlugins?: () => Awaitable<{
      pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
      gatewayMethods: string[];
    }>;
    onStartupPluginsLoading?: () => Awaitable<void>;
    onStartupPluginsLoaded?: (result: {
      pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
      gatewayMethods: string[];
    }) => Awaitable<void>;
    getCronService?: () => PluginHookGatewayCronService | undefined;
  },
  runtimeDeps: GatewayPostAttachRuntimeDeps = defaultGatewayPostAttachRuntimeDeps,
) {
  let pluginRegistry = params.pluginRegistry;
  if (params.loadStartupPlugins) {
    await measureStartup(params.startupTrace, "plugins.runtime-post-bind", async () => {
      await params.onStartupPluginsLoading?.();
      const loaded = await params.loadStartupPlugins!();
      pluginRegistry = loaded.pluginRegistry;
      await params.onStartupPluginsLoaded?.(loaded);
      params.startupTrace?.detail?.("plugins.runtime-post-bind", [
        [
          "loadedPluginCount",
          loaded.pluginRegistry.plugins.filter((plugin) => plugin.status === "loaded").length,
        ],
        ["gatewayMethodCount", loaded.gatewayMethods.length],
      ]);
    });
  }

  await measureStartup(params.startupTrace, "post-attach.log", () =>
    runtimeDeps.logGatewayStartup({
      cfg: params.cfgAtStart,
      bindHost: params.bindHost,
      bindHosts: params.bindHosts,
      port: params.port,
      tlsEnabled: params.tlsEnabled,
      loadedPluginIds: pluginRegistry.plugins
        .filter((plugin) => plugin.status === "loaded")
        .map((plugin) => plugin.id),
      log: params.log,
      isNixMode: params.isNixMode,
      startupStartedAt: params.startupStartedAt,
    }),
  );

  const stopGatewayUpdateCheckPromise = params.minimalTestGateway
    ? Promise.resolve(() => {})
    : measureStartup(params.startupTrace, "post-attach.update-check", () =>
        runtimeDeps.scheduleGatewayUpdateCheck({
          cfg: params.cfgAtStart,
          log: params.log,
          isNixMode: params.isNixMode,
          onUpdateAvailableChange: (updateAvailable) => {
            const payload: GatewayUpdateAvailableEventPayload = { updateAvailable };
            params.broadcast(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, { dropIfSlow: true });
          },
        }),
      );

  const tailscaleCleanupPromise = params.minimalTestGateway
    ? Promise.resolve(null)
    : params.tailscaleMode === "off" && !params.resetOnExit
      ? Promise.resolve(null)
      : measureStartup(params.startupTrace, "post-attach.tailscale", () =>
          runtimeDeps.startGatewayTailscaleExposure({
            tailscaleMode: params.tailscaleMode,
            resetOnExit: params.resetOnExit,
            port: params.port,
            controlUiBasePath: params.controlUiBasePath,
            logTailscale: params.logTailscale,
          }),
        );

  const sidecarsPromise = params.minimalTestGateway
    ? Promise.resolve({ pluginServices: null })
    : new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        params.log.info("starting channels and sidecars...");
        const result = await measureStartup(params.startupTrace, "sidecars.total", () =>
          runtimeDeps.startGatewaySidecars({
            cfg: params.gatewayPluginConfigAtStart,
            pluginRegistry,
            defaultWorkspaceDir: params.defaultWorkspaceDir,
            deps: params.deps,
            startChannels: params.startChannels,
            log: params.log,
            logHooks: params.logHooks,
            logChannels: params.logChannels,
            startupTrace: params.startupTrace,
          }),
        );
        for (const method of STARTUP_UNAVAILABLE_GATEWAY_METHODS) {
          params.unavailableGatewayMethods.delete(method);
        }
        params.onPluginServices?.(result.pluginServices);
        params.onPostReadySidecars?.(result.postReadySidecars ?? []);
        params.onSidecarsReady?.();
        params.startupTrace?.mark("sidecars.ready");
        params.startupTrace?.detail?.("sidecars.ready", [
          [
            "loadedPluginCount",
            pluginRegistry.plugins.filter((plugin) => plugin.status === "loaded").length,
          ],
          ["postReadySidecarCount", result.postReadySidecars?.length ?? 0],
        ]);
        return result;
      });

  void sidecarsPromise
    .then(async () => {
      if (params.minimalTestGateway) {
        return;
      }
      setImmediate(() => {
        void Promise.resolve(runtimeDeps.refreshLatestUpdateRestartSentinel()).catch((err) => {
          params.log.warn(`restart sentinel refresh failed after sidecars: ${String(err)}`);
        });
      });
      if (!pluginRegistry.typedHooks?.some((hook) => hook.hookName === "gateway_start")) {
        return;
      }
      const hookRunner = await runtimeDeps.getGlobalHookRunner();
      if (hookRunner?.hasHooks("gateway_start")) {
        void hookRunner
          .runGatewayStart(
            { port: params.port },
            {
              port: params.port,
              config: params.gatewayPluginConfigAtStart,
              workspaceDir: params.defaultWorkspaceDir,
              getCron: () =>
                params.getCronService?.() ??
                (params.deps.cron as PluginHookGatewayCronService | undefined),
            },
          )
          .catch((err) => {
            params.log.warn(`gateway_start hook failed: ${String(err)}`);
          });
      }
    })
    .catch((err) => {
      params.log.warn(`gateway sidecars failed to start: ${String(err)}`);
    });

  if (params.deferSidecars !== true) {
    const [stopGatewayUpdateCheck, tailscaleCleanup, sidecarsResult] = await Promise.all([
      stopGatewayUpdateCheckPromise,
      tailscaleCleanupPromise,
      sidecarsPromise,
    ]);
    return {
      stopGatewayUpdateCheck,
      tailscaleCleanup,
      pluginServices: sidecarsResult.pluginServices,
      postReadySidecars: sidecarsResult.postReadySidecars ?? [],
    };
  }

  const [stopGatewayUpdateCheck, tailscaleCleanup] = await Promise.all([
    stopGatewayUpdateCheckPromise,
    tailscaleCleanupPromise,
  ]);

  return { stopGatewayUpdateCheck, tailscaleCleanup, pluginServices: null };
}

export const __testing = {
  hasRestartSentinelFileFast,
  prewarmConfiguredPrimaryModel,
  prewarmConfiguredPrimaryModelWithTimeout,
  refreshLatestUpdateRestartSentinelIfPresent,
  resolveGatewayMemoryStartupPolicy,
  stopPostReadySidecarsAfterCloseStarted,
};

export type { GatewayPostReadySidecarHandle };
