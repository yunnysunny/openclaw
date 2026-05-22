// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "../infra/errors.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { isPathInside } from "../security/scan-paths.js";
import { isRecord } from "../utils.js";
import { maintainConfigBackups } from "./backup-rotation.js";
import { INCLUDE_KEY } from "./includes.js";
import { createInvalidConfigError, formatInvalidConfigDetails } from "./io.invalid-config.js";
import {
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  writeConfigFile,
  type ConfigWriteOptions,
} from "./io.js";
import { applyUnsetPathsForWrite, resolveManagedUnsetPathsForWrite } from "./io.write-prepare.js";
import { assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard.js";
import {
  createRuntimeConfigWriteNotification,
  finalizeRuntimeSnapshotWrite,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotRefreshHandler,
  getRuntimeConfigSourceSnapshot,
  notifyRuntimeConfigWriteListeners,
  resolveConfigWriteAfterWrite,
  resolveConfigWriteFollowUp,
  type ConfigWriteAfterWrite,
  type ConfigWriteFollowUp,
} from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

export type ConfigMutationBase = "runtime" | "source";

export class ConfigMutationConflictError extends Error {
  readonly currentHash: string | null;

  constructor(message: string, params: { currentHash: string | null }) {
    super(message);
    this.name = "ConfigMutationConflictError";
    this.currentHash = params.currentHash;
  }
}

export type ConfigReplaceResult = {
  path: string;
  previousHash: string | null;
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  persistedHash: string | null;
  afterWrite: ConfigWriteAfterWrite;
  followUp: ConfigWriteFollowUp;
};

export type ConfigMutationIO = {
  readConfigFileSnapshotForWrite: typeof readConfigFileSnapshotForWrite;
  writeConfigFile: (cfg: OpenClawConfig, options?: ConfigWriteOptions) => Promise<unknown>;
};

export type ConfigMutationContext = {
  snapshot: ConfigFileSnapshot;
  previousHash: string | null;
  baseHash?: string;
  attempt: number;
};
export type ConfigTransformResult<T> = {
  nextConfig: OpenClawConfig;
  result?: T;
};
export type ConfigMutationCommitParams = {
  nextConfig: OpenClawConfig;
  snapshot: ConfigFileSnapshot;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
  afterWrite: ConfigWriteAfterWrite;
  io?: ConfigMutationIO;
};
export type ConfigMutationCommitResult = {
  config: OpenClawConfig;
  persistedHash: string | null;
  afterWrite?: ConfigWriteAfterWrite;
};
export type ConfigMutationCommit = (
  params: ConfigMutationCommitParams,
) => Promise<ConfigMutationCommitResult>;
export type ConfigMutationResult<T> = ConfigReplaceResult & {
  result: T | undefined;
  attempts: number;
};
export type TransformConfigFileParams<T> = {
  base?: ConfigMutationBase;
  baseHash?: string;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
  transform: (
    currentConfig: OpenClawConfig,
    context: ConfigMutationContext,
  ) => Promise<ConfigTransformResult<T>> | ConfigTransformResult<T>;
  commit?: ConfigMutationCommit;
};
export type TransformConfigFileWithRetryParams<T> = TransformConfigFileParams<T> & {
  maxAttempts?: number;
  maxRetries?: number;
};

const DEFAULT_CONFIG_MUTATION_RETRY_ATTEMPTS = 5;
let configMutationQueueTail: Promise<void> = Promise.resolve();

async function withConfigMutationQueue<T>(fn: () => Promise<T>): Promise<T> {
  const previous = configMutationQueueTail;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  configMutationQueueTail = previous.catch(() => undefined).then(() => current);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

function resolveWriteResult(
  result: unknown,
  fallbackConfig: OpenClawConfig,
): { persistedHash: string | null; persistedConfig: OpenClawConfig } {
  if (isRecord(result)) {
    return {
      persistedHash: typeof result.persistedHash === "string" ? result.persistedHash : null,
      persistedConfig: isRecord(result.persistedConfig)
        ? (result.persistedConfig as OpenClawConfig)
        : fallbackConfig,
    };
  }
  return { persistedHash: null, persistedConfig: fallbackConfig };
}

export async function transformConfigFile<T = void>(
  params: TransformConfigFileParams<T> & { attempt?: number },
): Promise<ConfigMutationResult<T> & { attempts: number }> {
  const { snapshot, writeOptions } = await (
    params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite
  )();
  assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
  const transformed = await params.transform(baseConfig as OpenClawConfig, {
    snapshot,
    previousHash,
    baseHash: params.baseHash,
    attempt: params.attempt ?? 0,
  });
  const mergedWriteOptions = { ...writeOptions, ...params.writeOptions };
  const afterWrite = resolveConfigWriteAfterWrite(
    params.afterWrite ?? params.writeOptions?.afterWrite,
  );
  const committed = params.commit
    ? await params.commit({
        nextConfig: transformed.nextConfig,
        snapshot,
        baseHash: previousHash ?? undefined,
        writeOptions: mergedWriteOptions,
        afterWrite,
        io: params.io,
      })
    : await replaceConfigFile({
          nextConfig: transformed.nextConfig,
          baseHash: previousHash ?? undefined,
          snapshot,
          writeOptions: mergedWriteOptions,
          afterWrite,
          io: params.io,
        }).then((result) => ({
          config: result.nextConfig,
          persistedHash: result.persistedHash,
          afterWrite: result.afterWrite,
        }));
  const committedAfterWrite = committed.afterWrite ?? afterWrite;
  return {
    path: snapshot.path,
    previousHash,
    snapshot,
    nextConfig: committed.config,
    persistedHash: committed.persistedHash,
    afterWrite: committedAfterWrite,
    followUp: resolveConfigWriteFollowUp(committedAfterWrite),
    result: transformed.result,
    attempts: (params.attempt ?? 0) + 1,
  };
}

export async function transformConfigFileWithRetry<T = void>(
  params: TransformConfigFileWithRetryParams<T>,
): Promise<ConfigMutationResult<T> & { attempts: number }> {
  const maxRetries = Math.max(1, params.maxAttempts ?? params.maxRetries ?? DEFAULT_CONFIG_MUTATION_RETRY_ATTEMPTS);
  return await withConfigMutationQueue(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        return await transformConfigFile({ ...params, attempt });
      } catch (error) {
        lastError = error;
        if (!(error instanceof ConfigMutationConflictError)) {
          throw error;
        }
      }
    }
    throw lastError;
  });
}

export async function mutateConfigFileWithRetry<T = void>(params: {
  base?: ConfigMutationBase;
  baseHash?: string;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
  maxAttempts?: number;
  maxRetries?: number;
  mutate: (
    draft: OpenClawConfig,
    context: ConfigMutationContext,
  ) => Promise<T | void> | T | void;
}): Promise<ConfigMutationResult<T>> {
  return await transformConfigFileWithRetry<T>({
    base: params.base,
    baseHash: params.baseHash,
    afterWrite: params.afterWrite,
    writeOptions: params.writeOptions,
    io: params.io,
    maxAttempts: params.maxAttempts,
    maxRetries: params.maxRetries,
    transform: async (currentConfig, context) => {
      const draft = structuredClone(currentConfig);
      const result = (await params.mutate(draft, context)) as T | undefined;
      return { nextConfig: draft, result };
    },
  });
}

function assertBaseHashMatches(snapshot: ConfigFileSnapshot, expectedHash?: string): string | null {
  const currentHash = resolveConfigSnapshotHash(snapshot) ?? null;
  if (expectedHash !== undefined && expectedHash !== currentHash) {
    throw new ConfigMutationConflictError("config changed since last load", {
      currentHash,
    });
  }
  return currentHash;
}

function getChangedTopLevelKeys(base: unknown, next: unknown): string[] {
  if (!isRecord(base) || !isRecord(next)) {
    return isDeepStrictEqual(base, next) ? [] : ["<root>"];
  }
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
  return [...keys].filter((key) => !isDeepStrictEqual(base[key], next[key]));
}

function getSingleTopLevelIncludeTarget(params: {
  snapshot: ConfigFileSnapshot;
  key: string;
}): string | null {
  if (!isRecord(params.snapshot.parsed)) {
    return null;
  }
  const authoredSection = params.snapshot.parsed[params.key];
  if (!isRecord(authoredSection)) {
    return null;
  }
  const keys = Object.keys(authoredSection);
  const includeValue = authoredSection[INCLUDE_KEY];
  if (keys.length !== 1 || typeof includeValue !== "string") {
    return null;
  }

  const rootDir = path.dirname(params.snapshot.path);
  const resolved = path.normalize(
    path.isAbsolute(includeValue) ? includeValue : path.resolve(rootDir, includeValue),
  );
  if (!isPathInside(rootDir, resolved)) {
    return null;
  }
  return resolved;
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await replaceFileAtomic({
    filePath,
    content: `${JSON.stringify(value, null, 2)}\n`,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: path.basename(filePath),
    beforeRename: async () => {
      await fs.access(filePath).then(
        async () => await maintainConfigBackups(filePath, fs),
        () => undefined,
      );
    },
  });
}

async function tryWriteSingleTopLevelIncludeMutation(params: {
  snapshot: ConfigFileSnapshot;
  nextConfig: OpenClawConfig;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
}): Promise<{ persistedHash: string | null; persistedConfig: OpenClawConfig } | null> {
  const nextConfig = applyUnsetPathsForWrite(
    params.nextConfig,
    resolveManagedUnsetPathsForWrite(params.writeOptions?.unsetPaths),
  );
  const changedKeys = getChangedTopLevelKeys(params.snapshot.sourceConfig, nextConfig);
  if (changedKeys.length !== 1 || changedKeys[0] === "<root>") {
    return null;
  }

  const key = changedKeys[0];
  const includePath = getSingleTopLevelIncludeTarget({ snapshot: params.snapshot, key });
  if (!includePath || !isRecord(nextConfig) || !(key in nextConfig)) {
    return null;
  }
  const nextConfigRecord = nextConfig as Record<string, unknown>;

  const validated = validateConfigObjectWithPlugins(
    nextConfig,
    params.writeOptions?.skipPluginValidation ? { pluginValidation: "skip" } : undefined,
  );
  if (!validated.ok) {
    throw createInvalidConfigError(
      params.snapshot.path,
      formatInvalidConfigDetails(validated.issues),
    );
  }

  const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
  const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshot();
  const hadRuntimeSnapshot = Boolean(runtimeConfigSnapshot);
  const hadBothSnapshots = Boolean(runtimeConfigSnapshot && runtimeConfigSourceSnapshot);
  await writeJsonFileAtomic(includePath, nextConfigRecord[key]);
  if (
    params.writeOptions?.skipRuntimeSnapshotRefresh &&
    !hadRuntimeSnapshot &&
    !getRuntimeConfigSnapshotRefreshHandler()
  ) {
    return { persistedHash: null, persistedConfig: nextConfig };
  }

  const refreshed = await (
    params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite
  )(params.writeOptions?.skipPluginValidation ? { skipPluginValidation: true } : undefined);
  const refreshedSnapshot = refreshed.snapshot;
  const persistedHash = resolveConfigSnapshotHash(refreshedSnapshot);
  if (!refreshedSnapshot.valid) {
    throw createInvalidConfigError(
      params.snapshot.path,
      formatInvalidConfigDetails(refreshedSnapshot.issues),
    );
  }
  if (!persistedHash) {
    throw new Error(
      `Config was written to ${params.snapshot.path}, but no persisted hash was available.`,
    );
  }

  const notifyCommittedWrite = () => {
    const currentRuntimeConfig = getRuntimeConfigSnapshot();
    if (!currentRuntimeConfig) {
      return;
    }
    notifyRuntimeConfigWriteListeners(
      createRuntimeConfigWriteNotification({
        configPath: params.snapshot.path,
        sourceConfig: refreshedSnapshot.sourceConfig,
        runtimeConfig: currentRuntimeConfig,
        persistedHash,
        afterWrite: params.afterWrite ?? params.writeOptions?.afterWrite,
      }),
    );
  };
  await finalizeRuntimeSnapshotWrite({
    nextSourceConfig: refreshedSnapshot.sourceConfig,
    hadRuntimeSnapshot,
    hadBothSnapshots,
    loadFreshConfig: () => refreshedSnapshot.runtimeConfig,
    notifyCommittedWrite,
    formatRefreshError: (error) => formatErrorMessage(error),
    createRefreshError: (detail, cause) =>
      new Error(
        `Config was written to ${params.snapshot.path}, but runtime snapshot refresh failed: ${detail}`,
        { cause },
      ),
  });
  return { persistedHash, persistedConfig: refreshedSnapshot.sourceConfig };
}

export async function replaceConfigFile(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  snapshot?: ConfigFileSnapshot;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
}): Promise<ConfigReplaceResult> {
  const prepared =
    params.snapshot && params.writeOptions
      ? { snapshot: params.snapshot, writeOptions: params.writeOptions }
      : await (params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite)(
          params.writeOptions?.skipPluginValidation ? { skipPluginValidation: true } : undefined,
        );
  const { snapshot, writeOptions } = prepared;
  assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
  const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
  const afterWrite = resolveConfigWriteAfterWrite(
    params.afterWrite ?? params.writeOptions?.afterWrite,
  );
  const includeWriteResult = await tryWriteSingleTopLevelIncludeMutation({
    snapshot,
    nextConfig: params.nextConfig,
    afterWrite,
    writeOptions: params.writeOptions ?? writeOptions,
    io: params.io,
  });
  if (!includeWriteResult) {
    const writeResult = resolveWriteResult(
      await (params.io?.writeConfigFile ?? writeConfigFile)(params.nextConfig, {
        baseSnapshot: snapshot,
        ...writeOptions,
        ...params.writeOptions,
        afterWrite,
      }),
      params.nextConfig,
    );
    return {
      path: snapshot.path,
      previousHash,
      snapshot,
      nextConfig: writeResult.persistedConfig,
      persistedHash: writeResult.persistedHash,
      afterWrite,
      followUp: resolveConfigWriteFollowUp(afterWrite),
    };
  }
  return {
    path: snapshot.path,
    previousHash,
    snapshot,
    nextConfig: includeWriteResult.persistedConfig,
    persistedHash: includeWriteResult.persistedHash,
    afterWrite,
    followUp: resolveConfigWriteFollowUp(afterWrite),
  };
}

export async function mutateConfigFile<T = void>(params: {
  base?: ConfigMutationBase;
  baseHash?: string;
  afterWrite?: ConfigWriteOptions["afterWrite"];
  writeOptions?: ConfigWriteOptions;
  io?: ConfigMutationIO;
  mutate: (
    draft: OpenClawConfig,
    context: { snapshot: ConfigFileSnapshot; previousHash: string | null; attempt: number },
  ) => Promise<T | void> | T | void;
}): Promise<ConfigMutationResult<T>> {
  return await transformConfigFile<T>({
    base: params.base,
    baseHash: params.baseHash,
    afterWrite: params.afterWrite,
    writeOptions: params.writeOptions,
    io: params.io,
    transform: async (currentConfig, context) => {
      const draft = structuredClone(currentConfig);
      const result = (await params.mutate(draft, context)) as T | undefined;
      return { nextConfig: draft, result };
    },
  });
}
