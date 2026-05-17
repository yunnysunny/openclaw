import fs from "node:fs";
import path from "node:path";
import {
  matchBoundaryFileOpenFailure,
  openBoundaryFile,
  openBoundaryFileSync,
} from "../infra/boundary-file-read.js";
import { resolveBoundaryPathSync } from "../infra/boundary-path.js";
import { closeFileDescriptorAsync, readFileUtf8FromFd } from "../infra/fd-promise.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import {
  detectBundleManifestFormat,
  detectBundleManifestFormatAsync,
  loadBundleManifest,
  loadBundleManifestAsync,
} from "./bundle-manifest.js";
import type { PluginBundleFormat, PluginDiagnostic, PluginFormat } from "./manifest-types.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  loadPluginManifest,
  loadPluginManifestAsync,
  type PluginManifest,
  resolvePackageExtensionEntries,
  type OpenClawPackageManifest,
  type PackageManifest,
} from "./manifest.js";
import {
  formatPosixMode,
  isPathInside,
  safeRealpath,
  safeRealpathSync,
  safeStatSync,
} from "./path-safety.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import {
  resolvePluginCacheInputs,
  resolvePluginCacheInputsAsync,
  resolvePluginSourceRoots,
  resolvePluginSourceRootsAsync,
} from "./roots.js";

const EXTENSION_EXTS = new Set([".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);
const SCANNED_DIRECTORY_IGNORE_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  ".yarn",
  ".yarn-cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export type PluginCandidate = {
  idHint: string;
  source: string;
  setupSource?: string;
  rootDir: string;
  origin: PluginOrigin;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  workspaceDir?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageDir?: string;
  packageManifest?: OpenClawPackageManifest;
  bundledManifest?: PluginManifest;
  bundledManifestPath?: string;
};

export type PluginDiscoveryResult = {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
};

const discoveryCache = new Map<string, { expiresAt: number; result: PluginDiscoveryResult }>();

// Keep a short cache window to collapse bursty reloads during startup flows.
const DEFAULT_DISCOVERY_CACHE_MS = 1000;

export function clearPluginDiscoveryCache(): void {
  discoveryCache.clear();
}

function resolveDiscoveryCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return DEFAULT_DISCOVERY_CACHE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DISCOVERY_CACHE_MS;
  }
  return Math.max(0, parsed);
}

function shouldUseDiscoveryCache(env: NodeJS.ProcessEnv): boolean {
  const disabled = env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE?.trim();
  if (disabled) {
    return false;
  }
  return resolveDiscoveryCacheMs(env) > 0;
}

function buildScopedDiscoveryCacheKey(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  ownershipUid?: number | null;
  env: NodeJS.ProcessEnv;
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    loadPaths: params.extraPaths,
    env: params.env,
  });
  const workspaceKey = roots.workspace ?? "";
  const bundledRoot = roots.stock ?? "";
  const ownershipUid = params.ownershipUid ?? currentUid();
  return `scoped::${workspaceKey}::${bundledRoot}::${ownershipUid ?? "none"}::${JSON.stringify(loadPaths)}`;
}

function buildSharedDiscoveryCacheKey(params: {
  ownershipUid?: number | null;
  env: NodeJS.ProcessEnv;
}): string {
  const roots = resolvePluginSourceRoots({ env: params.env });
  const configExtensionsRoot = roots.global ?? "";
  const bundledRoot = roots.stock ?? "";
  const ownershipUid = params.ownershipUid ?? currentUid();
  return `shared::${ownershipUid ?? "none"}::${configExtensionsRoot}::${bundledRoot}`;
}

async function buildScopedDiscoveryCacheKeyAsync(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  ownershipUid?: number | null;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const { roots, loadPaths } = await resolvePluginCacheInputsAsync({
    workspaceDir: params.workspaceDir,
    loadPaths: params.extraPaths,
    env: params.env,
  });
  const workspaceKey = roots.workspace ?? "";
  const bundledRoot = roots.stock ?? "";
  const ownershipUid = params.ownershipUid ?? currentUid();
  return `scoped::${workspaceKey}::${bundledRoot}::${ownershipUid ?? "none"}::${JSON.stringify(loadPaths)}`;
}

async function buildSharedDiscoveryCacheKeyAsync(params: {
  ownershipUid?: number | null;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const roots = await resolvePluginSourceRootsAsync({ env: params.env });
  const configExtensionsRoot = roots.global ?? "";
  const bundledRoot = roots.stock ?? "";
  const ownershipUid = params.ownershipUid ?? currentUid();
  return `shared::${ownershipUid ?? "none"}::${configExtensionsRoot}::${bundledRoot}`;
}

function currentUid(overrideUid?: number | null): number | null {
  if (overrideUid !== undefined) {
    return overrideUid;
  }
  if (process.platform === "win32") {
    return null;
  }
  if (typeof process.getuid !== "function") {
    return null;
  }
  return process.getuid();
}

export type CandidateBlockReason =
  | "source_escapes_root"
  | "path_stat_failed"
  | "path_world_writable"
  | "path_suspicious_ownership";

type CandidateBlockIssue = {
  reason: CandidateBlockReason;
  sourcePath: string;
  rootPath: string;
  targetPath: string;
  sourceRealPath?: string;
  rootRealPath?: string;
  modeBits?: number;
  foundUid?: number;
  expectedUid?: number;
};

function checkSourceEscapesRoot(params: {
  source: string;
  rootDir: string;
}): CandidateBlockIssue | null {
  const sourceRealPath = safeRealpathSync(params.source);
  const rootRealPath = safeRealpathSync(params.rootDir);
  if (!sourceRealPath || !rootRealPath) {
    return null;
  }
  if (isPathInside(rootRealPath, sourceRealPath)) {
    return null;
  }
  return {
    reason: "source_escapes_root",
    sourcePath: params.source,
    rootPath: params.rootDir,
    targetPath: params.source,
    sourceRealPath,
    rootRealPath,
  };
}

function checkPathStatAndPermissions(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  uid: number | null;
}): CandidateBlockIssue | null {
  if (process.platform === "win32") {
    return null;
  }
  const pathsToCheck = [params.rootDir, params.source];
  const seen = new Set<string>();
  for (const targetPath of pathsToCheck) {
    const normalized = path.resolve(targetPath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    let stat = safeStatSync(targetPath);
    if (!stat) {
      return {
        reason: "path_stat_failed",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
      };
    }
    let modeBits = stat.mode & 0o777;
    if ((modeBits & 0o002) !== 0 && params.origin === "bundled") {
      // npm/global installs can create package-managed extension dirs without
      // directory entries in the tarball, which may widen them to 0777.
      // Tighten bundled dirs in place before applying the normal safety gate.
      try {
        fs.chmodSync(targetPath, modeBits & ~0o022);
        const repairedStat = safeStatSync(targetPath);
        if (!repairedStat) {
          return {
            reason: "path_stat_failed",
            sourcePath: params.source,
            rootPath: params.rootDir,
            targetPath,
          };
        }
        stat = repairedStat;
        modeBits = repairedStat.mode & 0o777;
      } catch {
        // Fall through to the normal block path below when repair is not possible.
      }
    }
    if ((modeBits & 0o002) !== 0) {
      return {
        reason: "path_world_writable",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        modeBits,
      };
    }
    if (
      params.origin !== "bundled" &&
      params.uid !== null &&
      typeof stat.uid === "number" &&
      stat.uid !== params.uid &&
      stat.uid !== 0
    ) {
      return {
        reason: "path_suspicious_ownership",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        foundUid: stat.uid,
        expectedUid: params.uid,
      };
    }
  }
  return null;
}

function findCandidateBlockIssue(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
}): CandidateBlockIssue | null {
  const escaped = checkSourceEscapesRoot({
    source: params.source,
    rootDir: params.rootDir,
  });
  if (escaped) {
    return escaped;
  }
  return checkPathStatAndPermissions({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    uid: currentUid(params.ownershipUid),
  });
}

function formatCandidateBlockMessage(issue: CandidateBlockIssue): string {
  if (issue.reason === "source_escapes_root") {
    return `blocked plugin candidate: source escapes plugin root (${issue.sourcePath} -> ${issue.sourceRealPath}; root=${issue.rootRealPath})`;
  }
  if (issue.reason === "path_stat_failed") {
    return `blocked plugin candidate: cannot stat path (${issue.targetPath})`;
  }
  if (issue.reason === "path_world_writable") {
    return `blocked plugin candidate: world-writable path (${issue.targetPath}, mode=${formatPosixMode(issue.modeBits ?? 0)})`;
  }
  return `blocked plugin candidate: suspicious ownership (${issue.targetPath}, uid=${issue.foundUid}, expected uid=${issue.expectedUid} or root)`;
}

function isUnsafePluginCandidate(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  diagnostics: PluginDiagnostic[];
  ownershipUid?: number | null;
}): boolean {
  const issue = findCandidateBlockIssue({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    ownershipUid: params.ownershipUid,
  });
  if (!issue) {
    return false;
  }
  params.diagnostics.push({
    level: "warn",
    source: issue.targetPath,
    message: formatCandidateBlockMessage(issue),
  });
  return true;
}

function isExtensionFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  if (!EXTENSION_EXTS.has(ext)) {
    return false;
  }
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  const baseName = normalizeLowercaseStringOrEmpty(path.basename(filePath));
  return (
    !baseName.includes(".test.") &&
    !baseName.includes(".live.test.") &&
    !baseName.includes(".e2e.test.")
  );
}

function shouldIgnoreScannedDirectory(dirName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(dirName);
  if (!normalized) {
    return true;
  }
  if (SCANNED_DIRECTORY_IGNORE_NAMES.has(normalized)) {
    return true;
  }
  if (normalized.endsWith(".bak")) {
    return true;
  }
  if (normalized.includes(".backup-")) {
    return true;
  }
  if (normalized.includes(".disabled")) {
    return true;
  }
  return false;
}

function resolvesToSameDirectory(left?: string, right?: string): boolean {
  if (!left || !right) {
    return false;
  }
  const leftRealPath = safeRealpathSync(left);
  const rightRealPath = safeRealpathSync(right);
  if (leftRealPath && rightRealPath) {
    return leftRealPath === rightRealPath;
  }
  return path.resolve(left) === path.resolve(right);
}

function createDiscoveryResult(): PluginDiscoveryResult {
  return {
    candidates: [],
    diagnostics: [],
  };
}

function mergeDiscoveryResult(
  target: PluginDiscoveryResult,
  source: PluginDiscoveryResult,
  seenSources: Set<string>,
): void {
  for (const candidate of source.candidates) {
    const key = candidate.source;
    if (seenSources.has(key)) {
      continue;
    }
    seenSources.add(key);
    target.candidates.push(candidate);
  }
  target.diagnostics.push(...source.diagnostics);
}

function getCachedDiscoveryResult(params: {
  cacheEnabled: boolean;
  cacheKey: string;
  env: NodeJS.ProcessEnv;
  load: () => PluginDiscoveryResult;
}): PluginDiscoveryResult {
  const ttl = resolveDiscoveryCacheMs(params.env);
  if (params.cacheEnabled) {
    const cached = discoveryCache.get(params.cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
  }
  const result = params.load();
  if (params.cacheEnabled && ttl > 0) {
    discoveryCache.set(params.cacheKey, { expiresAt: Date.now() + ttl, result });
  }
  return result;
}

function readPackageManifest(dir: string, rejectHardlinks = true): PackageManifest | null {
  const manifestPath = path.join(dir, "package.json");
  const opened = openBoundaryFileSync({
    absolutePath: manifestPath,
    rootPath: dir,
    boundaryLabel: "plugin package directory",
    rejectHardlinks,
  });
  if (!opened.ok) {
    return null;
  }
  try {
    const raw = fs.readFileSync(opened.fd, "utf-8");
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return null;
  } finally {
    fs.closeSync(opened.fd);
  }
}

function deriveIdHint(params: {
  filePath: string;
  manifestId?: string;
  packageName?: string;
  hasMultipleExtensions: boolean;
}): string {
  const base = path.basename(params.filePath, path.extname(params.filePath));
  const rawManifestId = params.manifestId?.trim();
  if (rawManifestId) {
    return params.hasMultipleExtensions ? `${rawManifestId}/${base}` : rawManifestId;
  }
  const rawPackageName = params.packageName?.trim();
  if (!rawPackageName) {
    return base;
  }

  // Prefer the unscoped name so config keys stay stable even when the npm
  // package is scoped (example: @openclaw/voice-call -> voice-call).
  const unscoped = rawPackageName.includes("/")
    ? (rawPackageName.split("/").pop() ?? rawPackageName)
    : rawPackageName;
  const normalizedPackageId =
    unscoped.endsWith("-provider") && unscoped.length > "-provider".length
      ? unscoped.slice(0, -"-provider".length)
      : unscoped;

  if (!params.hasMultipleExtensions) {
    return normalizedPackageId;
  }
  return `${normalizedPackageId}/${base}`;
}

function resolveIdHintManifestId(rootDir: string, rejectHardlinks: boolean): string | undefined {
  const manifest = loadPluginManifest(rootDir, rejectHardlinks);
  return manifest.ok ? manifest.manifest.id : undefined;
}

function addCandidate(params: {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  idHint: string;
  source: string;
  setupSource?: string;
  rootDir: string;
  origin: PluginOrigin;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  ownershipUid?: number | null;
  workspaceDir?: string;
  manifest?: PackageManifest | null;
  packageDir?: string;
  bundledManifest?: PluginManifest;
  bundledManifestPath?: string;
}) {
  const resolved = path.resolve(params.source);
  if (params.seen.has(resolved)) {
    return;
  }
  const resolvedRoot = safeRealpathSync(params.rootDir) ?? path.resolve(params.rootDir);
  if (
    isUnsafePluginCandidate({
      source: resolved,
      rootDir: resolvedRoot,
      origin: params.origin,
      diagnostics: params.diagnostics,
      ownershipUid: params.ownershipUid,
    })
  ) {
    return;
  }
  params.seen.add(resolved);
  const manifest = params.manifest ?? null;
  params.candidates.push({
    idHint: params.idHint,
    source: resolved,
    setupSource: params.setupSource,
    rootDir: resolvedRoot,
    origin: params.origin,
    format: params.format ?? "openclaw",
    bundleFormat: params.bundleFormat,
    workspaceDir: params.workspaceDir,
    packageName: normalizeOptionalString(manifest?.name),
    packageVersion: normalizeOptionalString(manifest?.version),
    packageDescription: normalizeOptionalString(manifest?.description),
    packageDir: params.packageDir,
    packageManifest: getPackageManifestMetadata(manifest ?? undefined),
    bundledManifest: params.bundledManifest,
    bundledManifestPath: params.bundledManifestPath,
  });
}

function discoverBundleInRoot(params: {
  rootDir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}): "added" | "invalid" | "none" {
  const bundleFormat = detectBundleManifestFormat(params.rootDir);
  if (!bundleFormat) {
    return "none";
  }
  const bundleManifest = loadBundleManifest({
    rootDir: params.rootDir,
    bundleFormat,
    rejectHardlinks: params.origin !== "bundled",
  });
  if (!bundleManifest.ok) {
    params.diagnostics.push({
      level: "error",
      message: bundleManifest.error,
      source: bundleManifest.manifestPath,
    });
    return "invalid";
  }
  addCandidate({
    candidates: params.candidates,
    diagnostics: params.diagnostics,
    seen: params.seen,
    idHint: bundleManifest.manifest.id,
    source: params.rootDir,
    rootDir: params.rootDir,
    origin: params.origin,
    format: "bundle",
    bundleFormat,
    ownershipUid: params.ownershipUid,
    workspaceDir: params.workspaceDir,
  });
  return "added";
}

function resolvePackageEntrySource(params: {
  packageDir: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const source = path.resolve(params.packageDir, params.entryPath);
  const rejectHardlinks = params.rejectHardlinks ?? true;
  const candidates = [source];
  const openCandidate = (absolutePath: string): string | null => {
    const opened = openBoundaryFileSync({
      absolutePath,
      rootPath: params.packageDir,
      boundaryLabel: "plugin package directory",
      rejectHardlinks,
    });
    if (!opened.ok) {
      return matchBoundaryFileOpenFailure(opened, {
        path: () => null,
        io: () => {
          params.diagnostics.push({
            level: "warn",
            message: `extension entry unreadable (I/O error): ${params.entryPath}`,
            source: params.sourceLabel,
          });
          return null;
        },
        fallback: () => {
          params.diagnostics.push({
            level: "error",
            message: `extension entry escapes package directory: ${params.entryPath}`,
            source: params.sourceLabel,
          });
          return null;
        },
      });
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);
    return safeSource;
  };
  if (!rejectHardlinks) {
    const builtCandidate = source.replace(/\.[^.]+$/u, ".js");
    if (builtCandidate !== source) {
      candidates.push(builtCandidate);
    }
  }

  for (const candidate of new Set(candidates)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    return openCandidate(candidate);
  }

  return openCandidate(source);
}

function isTypeScriptPackageEntry(entryPath: string): boolean {
  return [".ts", ".mts", ".cts"].includes(normalizeLowercaseStringOrEmpty(path.extname(entryPath)));
}

function shouldInferBuiltRuntimeEntry(origin: PluginOrigin): boolean {
  return origin === "config" || origin === "global";
}

function resolveSafePackageEntry(params: {
  packageDir: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): { relativePath: string; existingSource?: string } | null {
  const absolutePath = path.resolve(params.packageDir, params.entryPath);
  if (fs.existsSync(absolutePath)) {
    const existingSource = resolvePackageEntrySource({
      packageDir: params.packageDir,
      entryPath: params.entryPath,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    if (!existingSource) {
      return null;
    }
    return {
      relativePath: path.relative(params.packageDir, absolutePath).replace(/\\/g, "/"),
      existingSource,
    };
  }

  try {
    resolveBoundaryPathSync({
      absolutePath,
      rootPath: params.packageDir,
      boundaryLabel: "plugin package directory",
    });
  } catch {
    params.diagnostics.push({
      level: "error",
      message: `extension entry escapes package directory: ${params.entryPath}`,
      source: params.sourceLabel,
    });
    return null;
  }
  return { relativePath: path.relative(params.packageDir, absolutePath).replace(/\\/g, "/") };
}

function listBuiltRuntimeEntryCandidates(entryPath: string): string[] {
  if (!isTypeScriptPackageEntry(entryPath)) {
    return [];
  }
  const normalized = entryPath.replace(/\\/g, "/");
  const withoutExtension = normalized.replace(/\.[^.]+$/u, "");
  const normalizedRelative = normalized.replace(/^\.\//u, "");
  const distWithoutExtension = normalizedRelative.startsWith("src/")
    ? `./dist/${normalizedRelative.slice("src/".length).replace(/\.[^.]+$/u, "")}`
    : `./dist/${withoutExtension.replace(/^\.\//u, "")}`;
  const withJavaScriptExtensions = (basePath: string) => [
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
  ];
  const candidates = [
    ...withJavaScriptExtensions(distWithoutExtension),
    ...withJavaScriptExtensions(withoutExtension),
  ];
  return [...new Set(candidates)].filter((candidate) => candidate !== normalized);
}

function resolveExistingPackageEntrySource(params: {
  packageDir: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const source = path.resolve(params.packageDir, params.entryPath);
  if (!fs.existsSync(source)) {
    return null;
  }
  return resolvePackageEntrySource(params);
}

function normalizePackageManifestStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
}

function resolvePackageRuntimeEntrySource(params: {
  packageDir: string;
  entryPath: string;
  runtimeEntryPath?: string;
  origin: PluginOrigin;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const safeEntry = resolveSafePackageEntry({
    packageDir: params.packageDir,
    entryPath: params.entryPath,
    sourceLabel: params.sourceLabel,
    diagnostics: params.diagnostics,
    rejectHardlinks: params.rejectHardlinks,
  });
  if (!safeEntry) {
    return null;
  }

  if (params.runtimeEntryPath) {
    const runtimeSource = resolvePackageEntrySource({
      packageDir: params.packageDir,
      entryPath: params.runtimeEntryPath,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    if (runtimeSource) {
      return runtimeSource;
    }
  }

  if (shouldInferBuiltRuntimeEntry(params.origin)) {
    for (const candidate of listBuiltRuntimeEntryCandidates(safeEntry.relativePath)) {
      const runtimeSource = resolveExistingPackageEntrySource({
        packageDir: params.packageDir,
        entryPath: candidate,
        sourceLabel: params.sourceLabel,
        diagnostics: params.diagnostics,
        rejectHardlinks: params.rejectHardlinks,
      });
      if (runtimeSource) {
        return runtimeSource;
      }
    }
  }

  if (safeEntry.existingSource) {
    return safeEntry.existingSource;
  }

  return resolvePackageEntrySource({
    packageDir: params.packageDir,
    entryPath: params.entryPath,
    sourceLabel: params.sourceLabel,
    diagnostics: params.diagnostics,
    rejectHardlinks: params.rejectHardlinks,
  });
}

function resolvePackageSetupSource(params: {
  packageDir: string;
  manifest: PackageManifest | null;
  origin: PluginOrigin;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const packageManifest = getPackageManifestMetadata(params.manifest ?? undefined);
  const setupEntryPath = normalizeOptionalString(packageManifest?.setupEntry);
  if (!setupEntryPath) {
    return null;
  }
  return resolvePackageRuntimeEntrySource({
    packageDir: params.packageDir,
    entryPath: setupEntryPath,
    runtimeEntryPath: normalizeOptionalString(packageManifest?.runtimeSetupEntry),
    origin: params.origin,
    sourceLabel: params.sourceLabel,
    diagnostics: params.diagnostics,
    rejectHardlinks: params.rejectHardlinks,
  });
}

function resolvePackageRuntimeExtensionEntries(params: {
  packageDir: string;
  manifest: PackageManifest | null;
  extensions: readonly string[];
  origin: PluginOrigin;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string[] {
  const packageManifest = getPackageManifestMetadata(params.manifest ?? undefined);
  const runtimeExtensions = normalizePackageManifestStringList(packageManifest?.runtimeExtensions);
  return params.extensions.flatMap((entryPath, index) => {
    const source = resolvePackageRuntimeEntrySource({
      packageDir: params.packageDir,
      entryPath,
      runtimeEntryPath:
        runtimeExtensions.length === params.extensions.length
          ? runtimeExtensions[index]
          : undefined,
      origin: params.origin,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    return source ? [source] : [];
  });
}

function discoverInDirectory(params: {
  dir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  recurseDirectories?: boolean;
  skipDirectories?: Set<string>;
  visitedDirectories?: Set<string>;
}) {
  if (!fs.existsSync(params.dir)) {
    return;
  }
  const resolvedDir = safeRealpathSync(params.dir) ?? path.resolve(params.dir);
  if (params.recurseDirectories) {
    if (params.visitedDirectories?.has(resolvedDir)) {
      return;
    }
    params.visitedDirectories?.add(resolvedDir);
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(params.dir, { withFileTypes: true });
  } catch (err) {
    params.diagnostics.push({
      level: "warn",
      message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
      source: params.dir,
    });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(params.dir, entry.name);
    if (entry.isFile()) {
      if (!isExtensionFile(fullPath)) {
        continue;
      }
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(entry.name, path.extname(entry.name)),
        source: fullPath,
        rootDir: path.dirname(fullPath),
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
      });
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (params.skipDirectories?.has(entry.name)) {
      continue;
    }
    if (shouldIgnoreScannedDirectory(entry.name)) {
      continue;
    }

    const rejectHardlinks = params.origin !== "bundled";
    const manifest = readPackageManifest(fullPath, rejectHardlinks);
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
    const manifestId = resolveIdHintManifestId(fullPath, rejectHardlinks);
    const setupSource = resolvePackageSetupSource({
      packageDir: fullPath,
      manifest,
      origin: params.origin,
      sourceLabel: fullPath,
      diagnostics: params.diagnostics,
      rejectHardlinks,
    });

    if (extensions.length > 0) {
      const resolvedRuntimeSources = resolvePackageRuntimeExtensionEntries({
        packageDir: fullPath,
        manifest,
        extensions,
        origin: params.origin,
        sourceLabel: fullPath,
        diagnostics: params.diagnostics,
        rejectHardlinks,
      });
      for (const resolved of resolvedRuntimeSources) {
        addCandidate({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: resolved,
            manifestId,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source: resolved,
          ...(setupSource ? { setupSource } : {}),
          rootDir: fullPath,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: fullPath,
        });
      }
      continue;
    }

    const bundleDiscovery = discoverBundleInRoot({
      rootDir: fullPath,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
    });
    if (bundleDiscovery === "added") {
      continue;
    }

    const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES]
      .map((candidate) => path.join(fullPath, candidate))
      .find((candidate) => fs.existsSync(candidate));
    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: entry.name,
        source: indexFile,
        ...(setupSource ? { setupSource } : {}),
        rootDir: fullPath,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: fullPath,
      });
      continue;
    }

    if (params.recurseDirectories) {
      discoverInDirectory({
        ...params,
        dir: fullPath,
      });
    }
  }
}

function discoverFromPath(params: {
  rawPath: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}) {
  const resolved = resolveUserPath(params.rawPath, params.env);
  if (!fs.existsSync(resolved)) {
    params.diagnostics.push({
      level: "error",
      message: `plugin path not found: ${resolved}`,
      source: resolved,
    });
    return;
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    if (!isExtensionFile(resolved)) {
      params.diagnostics.push({
        level: "error",
        message: `plugin path is not a supported file: ${resolved}`,
        source: resolved,
      });
      return;
    }
    addCandidate({
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      idHint: path.basename(resolved, path.extname(resolved)),
      source: resolved,
      rootDir: path.dirname(resolved),
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
    });
    return;
  }

  if (stat.isDirectory()) {
    const rejectHardlinks = params.origin !== "bundled";
    const manifest = readPackageManifest(resolved, rejectHardlinks);
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
    const manifestId = resolveIdHintManifestId(resolved, rejectHardlinks);
    const setupSource = resolvePackageSetupSource({
      packageDir: resolved,
      manifest,
      origin: params.origin,
      sourceLabel: resolved,
      diagnostics: params.diagnostics,
      rejectHardlinks,
    });

    if (extensions.length > 0) {
      const resolvedRuntimeSources = resolvePackageRuntimeExtensionEntries({
        packageDir: resolved,
        manifest,
        extensions,
        origin: params.origin,
        sourceLabel: resolved,
        diagnostics: params.diagnostics,
        rejectHardlinks,
      });
      for (const source of resolvedRuntimeSources) {
        addCandidate({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: source,
            manifestId,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source,
          ...(setupSource ? { setupSource } : {}),
          rootDir: resolved,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: resolved,
        });
      }
      return;
    }

    const bundleDiscovery = discoverBundleInRoot({
      rootDir: resolved,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
    });
    if (bundleDiscovery === "added") {
      return;
    }

    const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES]
      .map((candidate) => path.join(resolved, candidate))
      .find((candidate) => fs.existsSync(candidate));

    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(resolved),
        source: indexFile,
        ...(setupSource ? { setupSource } : {}),
        rootDir: resolved,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: resolved,
      });
      return;
    }

    discoverInDirectory({
      dir: resolved,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
    });
    return;
  }
}

export function discoverOpenClawPlugins(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  ownershipUid?: number | null;
  cache?: boolean;
  env?: NodeJS.ProcessEnv;
}): PluginDiscoveryResult {
  const env = params.env ?? process.env;
  const cacheEnabled = params.cache !== false && shouldUseDiscoveryCache(env);
  const workspaceDir = normalizeOptionalString(params.workspaceDir);
  const workspaceRoot = workspaceDir ? resolveUserPath(workspaceDir, env) : undefined;
  const roots = resolvePluginSourceRoots({ workspaceDir: workspaceRoot, env });
  const scopedResult = getCachedDiscoveryResult({
    cacheEnabled,
    cacheKey: buildScopedDiscoveryCacheKey({
      workspaceDir: params.workspaceDir,
      extraPaths: params.extraPaths,
      ownershipUid: params.ownershipUid,
      env,
    }),
    env,
    load: () => {
      const result = createDiscoveryResult();
      const seen = new Set<string>();
      const extra = params.extraPaths ?? [];
      for (const extraPath of extra) {
        if (typeof extraPath !== "string") {
          continue;
        }
        const trimmed = extraPath.trim();
        if (!trimmed) {
          continue;
        }
        discoverFromPath({
          rawPath: trimmed,
          origin: "config",
          ownershipUid: params.ownershipUid,
          workspaceDir,
          env,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
        });
      }
      const workspaceMatchesBundledRoot = resolvesToSameDirectory(workspaceRoot, roots.stock);
      if (roots.workspace && workspaceRoot && !workspaceMatchesBundledRoot) {
        // Keep workspace auto-discovery constrained to the OpenClaw extensions root.
        // Recursively scanning the full workspace treats arbitrary project folders as
        // plugin candidates and causes noisy "plugin manifest not found" validation failures.
        discoverInDirectory({
          dir: roots.workspace,
          origin: "workspace",
          ownershipUid: params.ownershipUid,
          workspaceDir: workspaceRoot,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
        });
      }
      return result;
    },
  });
  const sharedResult = getCachedDiscoveryResult({
    cacheEnabled,
    cacheKey: buildSharedDiscoveryCacheKey({
      ownershipUid: params.ownershipUid,
      env,
    }),
    env,
    load: () => {
      const result = createDiscoveryResult();
      const seen = new Set<string>();
      if (roots.stock) {
        discoverInDirectory({
          dir: roots.stock,
          origin: "bundled",
          ownershipUid: params.ownershipUid,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
        });
      }
      // Keep auto-discovered global extensions behind bundled plugins.
      // Users can still intentionally override via plugins.load.paths (origin=config).
      discoverInDirectory({
        dir: roots.global,
        origin: "global",
        ownershipUid: params.ownershipUid,
        candidates: result.candidates,
        diagnostics: result.diagnostics,
        seen,
      });
      return result;
    },
  });
  const result = createDiscoveryResult();
  const seenSources = new Set<string>();
  mergeDiscoveryResult(result, scopedResult, seenSources);
  mergeDiscoveryResult(result, sharedResult, seenSources);
  return result;
}

async function discoveryPathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageManifestAsync(
  dir: string,
  rejectHardlinks = true,
): Promise<PackageManifest | null> {
  const manifestPath = path.join(dir, "package.json");
  const opened = await openBoundaryFile({
    absolutePath: manifestPath,
    rootPath: dir,
    boundaryLabel: "plugin package directory",
    rejectHardlinks,
  });
  if (!opened.ok) {
    return null;
  }
  try {
    const text = await readFileUtf8FromFd(opened.fd);
    return JSON.parse(text) as PackageManifest;
  } catch {
    return null;
  } finally {
    await closeFileDescriptorAsync(opened.fd);
  }
}

async function resolveIdHintManifestIdAsync(
  rootDir: string,
  rejectHardlinks: boolean,
): Promise<string | undefined> {
  const manifest = await loadPluginManifestAsync(rootDir, rejectHardlinks);
  return manifest.ok ? manifest.manifest.id : undefined;
}

async function checkSourceEscapesRootAsync(params: {
  source: string;
  rootDir: string;
}): Promise<CandidateBlockIssue | null> {
  const sourceRealPath = await safeRealpath(params.source);
  const rootRealPath = await safeRealpath(params.rootDir);
  if (!sourceRealPath || !rootRealPath) {
    return null;
  }
  if (isPathInside(rootRealPath, sourceRealPath)) {
    return null;
  }
  return {
    reason: "source_escapes_root",
    sourcePath: params.source,
    rootPath: params.rootDir,
    targetPath: params.source,
    sourceRealPath,
    rootRealPath,
  };
}

async function checkPathStatAndPermissionsAsync(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  uid: number | null;
}): Promise<CandidateBlockIssue | null> {
  if (process.platform === "win32") {
    return null;
  }
  const pathsToCheck = [params.rootDir, params.source];
  const seen = new Set<string>();
  for (const targetPath of pathsToCheck) {
    const normalized = path.resolve(targetPath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(targetPath);
    } catch {
      return {
        reason: "path_stat_failed",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
      };
    }
    let modeBits = stat.mode & 0o777;
    if ((modeBits & 0o002) !== 0 && params.origin === "bundled") {
      try {
        await fs.promises.chmod(targetPath, modeBits & ~0o022);
        let repairedStat: fs.Stats;
        try {
          repairedStat = await fs.promises.stat(targetPath);
        } catch {
          return {
            reason: "path_stat_failed",
            sourcePath: params.source,
            rootPath: params.rootDir,
            targetPath,
          };
        }
        stat = repairedStat;
        modeBits = repairedStat.mode & 0o777;
      } catch {
        // Fall through to the normal block path below when repair is not possible.
      }
    }
    if ((modeBits & 0o002) !== 0) {
      return {
        reason: "path_world_writable",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        modeBits,
      };
    }
    if (
      params.origin !== "bundled" &&
      params.uid !== null &&
      typeof stat.uid === "number" &&
      stat.uid !== params.uid &&
      stat.uid !== 0
    ) {
      return {
        reason: "path_suspicious_ownership",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        foundUid: stat.uid,
        expectedUid: params.uid,
      };
    }
  }
  return null;
}

async function findCandidateBlockIssueAsync(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
}): Promise<CandidateBlockIssue | null> {
  const escaped = await checkSourceEscapesRootAsync({
    source: params.source,
    rootDir: params.rootDir,
  });
  if (escaped) {
    return escaped;
  }
  return checkPathStatAndPermissionsAsync({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    uid: currentUid(params.ownershipUid),
  });
}

async function isUnsafePluginCandidateAsync(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  diagnostics: PluginDiagnostic[];
  ownershipUid?: number | null;
}): Promise<boolean> {
  const issue = await findCandidateBlockIssueAsync({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    ownershipUid: params.ownershipUid,
  });
  if (!issue) {
    return false;
  }
  params.diagnostics.push({
    level: "warn",
    source: issue.targetPath,
    message: formatCandidateBlockMessage(issue),
  });
  return true;
}

async function addCandidateAsync(params: {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  idHint: string;
  source: string;
  setupSource?: string;
  rootDir: string;
  origin: PluginOrigin;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  ownershipUid?: number | null;
  workspaceDir?: string;
  manifest?: PackageManifest | null;
  packageDir?: string;
  bundledManifest?: PluginManifest;
  bundledManifestPath?: string;
}): Promise<void> {
  const resolved = path.resolve(params.source);
  if (params.seen.has(resolved)) {
    return;
  }
  const resolvedRoot = (await safeRealpath(params.rootDir)) ?? path.resolve(params.rootDir);
  if (
    await isUnsafePluginCandidateAsync({
      source: resolved,
      rootDir: resolvedRoot,
      origin: params.origin,
      diagnostics: params.diagnostics,
      ownershipUid: params.ownershipUid,
    })
  ) {
    return;
  }
  params.seen.add(resolved);
  const manifest = params.manifest ?? null;
  params.candidates.push({
    idHint: params.idHint,
    source: resolved,
    setupSource: params.setupSource,
    rootDir: resolvedRoot,
    origin: params.origin,
    format: params.format ?? "openclaw",
    bundleFormat: params.bundleFormat,
    workspaceDir: params.workspaceDir,
    packageName: normalizeOptionalString(manifest?.name),
    packageVersion: normalizeOptionalString(manifest?.version),
    packageDescription: normalizeOptionalString(manifest?.description),
    packageDir: params.packageDir,
    packageManifest: getPackageManifestMetadata(manifest ?? undefined),
    bundledManifest: params.bundledManifest,
    bundledManifestPath: params.bundledManifestPath,
  });
}

async function resolvesToSameDirectoryAsync(left?: string, right?: string): Promise<boolean> {
  if (!left || !right) {
    return false;
  }
  const leftRealPath = await safeRealpath(left);
  const rightRealPath = await safeRealpath(right);
  if (leftRealPath && rightRealPath) {
    return leftRealPath === rightRealPath;
  }
  return path.resolve(left) === path.resolve(right);
}

async function resolvePackageEntrySourceAsync(params: {
  packageDir: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): Promise<string | null> {
  const source = path.resolve(params.packageDir, params.entryPath);
  const rejectHardlinks = params.rejectHardlinks ?? true;
  const candidates = [source];
  const openCandidate = async (absolutePath: string): Promise<string | null> => {
    const opened = await openBoundaryFile({
      absolutePath,
      rootPath: params.packageDir,
      boundaryLabel: "plugin package directory",
      rejectHardlinks,
    });
    if (!opened.ok) {
      return matchBoundaryFileOpenFailure(opened, {
        path: () => null,
        io: () => {
          params.diagnostics.push({
            level: "warn",
            message: `extension entry unreadable (I/O error): ${params.entryPath}`,
            source: params.sourceLabel,
          });
          return null;
        },
        fallback: () => {
          params.diagnostics.push({
            level: "error",
            message: `extension entry escapes package directory: ${params.entryPath}`,
            source: params.sourceLabel,
          });
          return null;
        },
      });
    }
    const safeSource = opened.path;
    await closeFileDescriptorAsync(opened.fd);
    return safeSource;
  };
  if (!rejectHardlinks) {
    const builtCandidate = source.replace(/\.[^.]+$/u, ".js");
    if (builtCandidate !== source) {
      candidates.push(builtCandidate);
    }
  }

  for (const candidate of new Set(candidates)) {
    if (!(await discoveryPathExists(candidate))) {
      continue;
    }
    return openCandidate(candidate);
  }

  return openCandidate(source);
}

async function discoverBundleInRootAsync(params: {
  rootDir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}): Promise<"added" | "invalid" | "none"> {
  const bundleFormat = await detectBundleManifestFormatAsync(params.rootDir);
  if (!bundleFormat) {
    return "none";
  }
  const bundleManifest = await loadBundleManifestAsync({
    rootDir: params.rootDir,
    bundleFormat,
    rejectHardlinks: params.origin !== "bundled",
  });
  if (!bundleManifest.ok) {
    params.diagnostics.push({
      level: "error",
      message: bundleManifest.error,
      source: bundleManifest.manifestPath,
    });
    return "invalid";
  }
  await addCandidateAsync({
    candidates: params.candidates,
    diagnostics: params.diagnostics,
    seen: params.seen,
    idHint: bundleManifest.manifest.id,
    source: params.rootDir,
    rootDir: params.rootDir,
    origin: params.origin,
    format: "bundle",
    bundleFormat,
    ownershipUid: params.ownershipUid,
    workspaceDir: params.workspaceDir,
  });
  return "added";
}

async function discoverInDirectoryAsync(params: {
  dir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  recurseDirectories?: boolean;
  skipDirectories?: Set<string>;
  visitedDirectories?: Set<string>;
}): Promise<void> {
  if (!(await discoveryPathExists(params.dir))) {
    return;
  }
  const resolvedDir = (await safeRealpath(params.dir)) ?? path.resolve(params.dir);
  if (params.recurseDirectories) {
    if (params.visitedDirectories?.has(resolvedDir)) {
      return;
    }
    params.visitedDirectories?.add(resolvedDir);
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(params.dir, { withFileTypes: true });
  } catch (err) {
    params.diagnostics.push({
      level: "warn",
      message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
      source: params.dir,
    });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(params.dir, entry.name);
    if (entry.isFile()) {
      if (!isExtensionFile(fullPath)) {
        continue;
      }
      await addCandidateAsync({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(entry.name, path.extname(entry.name)),
        source: fullPath,
        rootDir: path.dirname(fullPath),
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
      });
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (params.skipDirectories?.has(entry.name)) {
      continue;
    }
    if (shouldIgnoreScannedDirectory(entry.name)) {
      continue;
    }

    const rejectHardlinks = params.origin !== "bundled";
    const manifest = await readPackageManifestAsync(fullPath, rejectHardlinks);
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
    const manifestId = await resolveIdHintManifestIdAsync(fullPath, rejectHardlinks);
    const setupEntryPath = getPackageManifestMetadata(manifest ?? undefined)?.setupEntry;
    const setupSource =
      typeof setupEntryPath === "string" && setupEntryPath.trim().length > 0
        ? await resolvePackageEntrySourceAsync({
            packageDir: fullPath,
            entryPath: setupEntryPath,
            sourceLabel: fullPath,
            diagnostics: params.diagnostics,
            rejectHardlinks,
          })
        : null;

    if (extensions.length > 0) {
      for (const extPath of extensions) {
        const resolved = await resolvePackageEntrySourceAsync({
          packageDir: fullPath,
          entryPath: extPath,
          sourceLabel: fullPath,
          diagnostics: params.diagnostics,
          rejectHardlinks,
        });
        if (!resolved) {
          continue;
        }
        await addCandidateAsync({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: resolved,
            manifestId,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source: resolved,
          ...(setupSource ? { setupSource } : {}),
          rootDir: fullPath,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: fullPath,
        });
      }
      continue;
    }

    const bundleDiscovery = await discoverBundleInRootAsync({
      rootDir: fullPath,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
    });
    if (bundleDiscovery === "added") {
      continue;
    }

    let indexFile: string | undefined;
    for (const candidate of DEFAULT_PLUGIN_ENTRY_CANDIDATES) {
      const candidatePath = path.join(fullPath, candidate);
      if (await discoveryPathExists(candidatePath)) {
        indexFile = candidatePath;
        break;
      }
    }
    if (indexFile && isExtensionFile(indexFile)) {
      await addCandidateAsync({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: entry.name,
        source: indexFile,
        ...(setupSource ? { setupSource } : {}),
        rootDir: fullPath,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: fullPath,
      });
      continue;
    }

    if (params.recurseDirectories) {
      await discoverInDirectoryAsync({
        ...params,
        dir: fullPath,
      });
    }
  }
}

async function discoverFromPathAsync(params: {
  rawPath: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}): Promise<void> {
  const resolved = resolveUserPath(params.rawPath, params.env);
  if (!(await discoveryPathExists(resolved))) {
    params.diagnostics.push({
      level: "error",
      message: `plugin path not found: ${resolved}`,
      source: resolved,
    });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    params.diagnostics.push({
      level: "error",
      message: `plugin path not found: ${resolved}`,
      source: resolved,
    });
    return;
  }

  if (stat.isFile()) {
    if (!isExtensionFile(resolved)) {
      params.diagnostics.push({
        level: "error",
        message: `plugin path is not a supported file: ${resolved}`,
        source: resolved,
      });
      return;
    }
    await addCandidateAsync({
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      idHint: path.basename(resolved, path.extname(resolved)),
      source: resolved,
      rootDir: path.dirname(resolved),
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
    });
    return;
  }

  if (stat.isDirectory()) {
    const rejectHardlinks = params.origin !== "bundled";
    const manifest = await readPackageManifestAsync(resolved, rejectHardlinks);
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
    const manifestId = await resolveIdHintManifestIdAsync(resolved, rejectHardlinks);
    const setupEntryPath = getPackageManifestMetadata(manifest ?? undefined)?.setupEntry;
    const setupSource =
      typeof setupEntryPath === "string" && setupEntryPath.trim().length > 0
        ? await resolvePackageEntrySourceAsync({
            packageDir: resolved,
            entryPath: setupEntryPath,
            sourceLabel: resolved,
            diagnostics: params.diagnostics,
            rejectHardlinks,
          })
        : null;

    if (extensions.length > 0) {
      for (const extPath of extensions) {
        const source = await resolvePackageEntrySourceAsync({
          packageDir: resolved,
          entryPath: extPath,
          sourceLabel: resolved,
          diagnostics: params.diagnostics,
          rejectHardlinks,
        });
        if (!source) {
          continue;
        }
        await addCandidateAsync({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: source,
            manifestId,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source,
          ...(setupSource ? { setupSource } : {}),
          rootDir: resolved,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: resolved,
        });
      }
      return;
    }

    const bundleDiscovery = await discoverBundleInRootAsync({
      rootDir: resolved,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
    });
    if (bundleDiscovery === "added") {
      return;
    }

    let indexFile: string | undefined;
    for (const candidate of DEFAULT_PLUGIN_ENTRY_CANDIDATES) {
      const candidatePath = path.join(resolved, candidate);
      if (await discoveryPathExists(candidatePath)) {
        indexFile = candidatePath;
        break;
      }
    }

    if (indexFile && isExtensionFile(indexFile)) {
      await addCandidateAsync({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(resolved),
        source: indexFile,
        ...(setupSource ? { setupSource } : {}),
        rootDir: resolved,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: resolved,
      });
      return;
    }

    await discoverInDirectoryAsync({
      dir: resolved,
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
    });
  }
}

async function getCachedDiscoveryResultAsync(params: {
  cacheEnabled: boolean;
  cacheKey: string;
  env: NodeJS.ProcessEnv;
  load: () => Promise<PluginDiscoveryResult>;
}): Promise<PluginDiscoveryResult> {
  const ttl = resolveDiscoveryCacheMs(params.env);
  if (params.cacheEnabled) {
    const cached = discoveryCache.get(params.cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
  }
  const result = await params.load();
  if (params.cacheEnabled && ttl > 0) {
    discoveryCache.set(params.cacheKey, { expiresAt: Date.now() + ttl, result });
  }
  return result;
}

export async function discoverOpenClawPluginsAsync(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  ownershipUid?: number | null;
  cache?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginDiscoveryResult> {
  const env = params.env ?? process.env;
  const cacheEnabled = params.cache !== false && shouldUseDiscoveryCache(env);
  const workspaceDir = normalizeOptionalString(params.workspaceDir);
  const workspaceRoot = workspaceDir ? resolveUserPath(workspaceDir, env) : undefined;
  const roots = await resolvePluginSourceRootsAsync({ workspaceDir: workspaceRoot, env });
  const scopedCacheKey = await buildScopedDiscoveryCacheKeyAsync({
    workspaceDir: params.workspaceDir,
    extraPaths: params.extraPaths,
    ownershipUid: params.ownershipUid,
    env,
  });
  const sharedCacheKey = await buildSharedDiscoveryCacheKeyAsync({
    ownershipUid: params.ownershipUid,
    env,
  });
  const scopedResult = await getCachedDiscoveryResultAsync({
    cacheEnabled,
    cacheKey: scopedCacheKey,
    env,
    load: async () => {
      const result = createDiscoveryResult();
      const seen = new Set<string>();
      const extra = params.extraPaths ?? [];
      for (const extraPath of extra) {
        if (typeof extraPath !== "string") {
          continue;
        }
        const trimmed = extraPath.trim();
        if (!trimmed) {
          continue;
        }
        await discoverFromPathAsync({
          rawPath: trimmed,
          origin: "config",
          ownershipUid: params.ownershipUid,
          workspaceDir,
          env,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
        });
      }
      const workspaceMatchesBundledRoot = await resolvesToSameDirectoryAsync(
        workspaceRoot,
        roots.stock,
      );
      if (roots.workspace && workspaceRoot && !workspaceMatchesBundledRoot) {
        await discoverInDirectoryAsync({
          dir: roots.workspace,
          origin: "workspace",
          ownershipUid: params.ownershipUid,
          workspaceDir: workspaceRoot,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
        });
      }
      return result;
    },
  });
  const sharedResult = await getCachedDiscoveryResultAsync({
    cacheEnabled,
    cacheKey: sharedCacheKey,
    env,
    load: async () => {
      const result = createDiscoveryResult();
      const seen = new Set<string>();
      if (roots.stock) {
        await discoverInDirectoryAsync({
          dir: roots.stock,
          origin: "bundled",
          ownershipUid: params.ownershipUid,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
        });
      }
      await discoverInDirectoryAsync({
        dir: roots.global,
        origin: "global",
        ownershipUid: params.ownershipUid,
        candidates: result.candidates,
        diagnostics: result.diagnostics,
        seen,
      });
      return result;
    },
  });
  const result = createDiscoveryResult();
  const seenSources = new Set<string>();
  mergeDiscoveryResult(result, scopedResult, seenSources);
  mergeDiscoveryResult(result, sharedResult, seenSources);
  return result;
}
