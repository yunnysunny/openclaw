import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import {
  matchBoundaryFileOpenFailure,
  openBoundaryFile,
  openBoundaryFileSync,
} from "../infra/boundary-file-read.js";
import { closeFileDescriptorAsync, readFileUtf8FromFd } from "../infra/fd-promise.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import type { PluginBundleFormat } from "./manifest-types.js";
import { DEFAULT_PLUGIN_ENTRY_CANDIDATES, PLUGIN_MANIFEST_FILENAME } from "./manifest.js";

export const CODEX_BUNDLE_MANIFEST_RELATIVE_PATH = ".codex-plugin/plugin.json";
export const CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH = ".claude-plugin/plugin.json";
export const CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH = ".cursor-plugin/plugin.json";

export type BundlePluginManifest = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  skills: string[];
  settingsFiles?: string[];
  // Only include hook roots that OpenClaw can execute via HOOK.md + handler files.
  hooks: string[];
  bundleFormat: PluginBundleFormat;
  capabilities: string[];
};

export type BundleManifestLoadResult =
  | { ok: true; manifest: BundlePluginManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

type BundleManifestFileLoadResult =
  | { ok: true; raw: Record<string, unknown>; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

function normalizePathList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function normalizeBundlePathList(value: unknown): string[] {
  return Array.from(new Set(normalizePathList(value)));
}

export function mergeBundlePathLists(...groups: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged;
}

async function pathExistsAsync(candidatePath: string): Promise<boolean> {
  try {
    await fs.promises.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function bundlePathExists(rootDir: string, ...segments: string[]): Promise<boolean> {
  return pathExistsAsync(path.join(rootDir, ...segments));
}

async function bundleChildExists(rootDir: string, relativePath: string): Promise<boolean> {
  return pathExistsAsync(path.join(rootDir, relativePath));
}

function hasInlineCapabilityValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return value === true;
}

function slugifyPluginId(raw: string | undefined, rootDir: string): string {
  const fallback = path.basename(rootDir);
  const source = normalizeLowercaseStringOrEmpty(raw) || normalizeLowercaseStringOrEmpty(fallback);
  const slug = source
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "bundle-plugin";
}

function loadBundleManifestFile(params: {
  rootDir: string;
  manifestRelativePath: string;
  rejectHardlinks: boolean;
  allowMissing?: boolean;
}): BundleManifestFileLoadResult {
  const manifestPath = path.join(params.rootDir, params.manifestRelativePath);
  const opened = openBoundaryFileSync({
    absolutePath: manifestPath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: params.rejectHardlinks,
  });
  if (!opened.ok) {
    return matchBoundaryFileOpenFailure(opened, {
      path: () => {
        if (params.allowMissing) {
          return { ok: true, raw: {}, manifestPath };
        }
        return { ok: false, error: `plugin manifest not found: ${manifestPath}`, manifestPath };
      },
      fallback: (failure) => ({
        ok: false,
        error: `unsafe plugin manifest path: ${manifestPath} (${failure.reason})`,
        manifestPath,
      }),
    });
  }
  try {
    const raw = JSON5.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    if (!isRecord(raw)) {
      return { ok: false, error: "plugin manifest must be an object", manifestPath };
    }
    return { ok: true, raw, manifestPath };
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse plugin manifest: ${String(err)}`,
      manifestPath,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

async function loadBundleManifestFileAsync(params: {
  rootDir: string;
  manifestRelativePath: string;
  rejectHardlinks: boolean;
  allowMissing?: boolean;
}): Promise<BundleManifestFileLoadResult> {
  const manifestPath = path.join(params.rootDir, params.manifestRelativePath);
  const opened = await openBoundaryFile({
    absolutePath: manifestPath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: params.rejectHardlinks,
  });
  if (!opened.ok) {
    return matchBoundaryFileOpenFailure(opened, {
      path: () => {
        if (params.allowMissing) {
          return { ok: true, raw: {}, manifestPath };
        }
        return { ok: false, error: `plugin manifest not found: ${manifestPath}`, manifestPath };
      },
      fallback: (failure) => ({
        ok: false,
        error: `unsafe plugin manifest path: ${manifestPath} (${failure.reason})`,
        manifestPath,
      }),
    });
  }
  try {
    const text = await readFileUtf8FromFd(opened.fd);
    const raw = JSON5.parse(text) as unknown;
    if (!isRecord(raw)) {
      return { ok: false, error: "plugin manifest must be an object", manifestPath };
    }
    return { ok: true, raw, manifestPath };
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse plugin manifest: ${String(err)}`,
      manifestPath,
    };
  } finally {
    await closeFileDescriptorAsync(opened.fd);
  }
}

function resolveCodexSkillDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  const declared = normalizeBundlePathList(raw.skills);
  if (declared.length > 0) {
    return declared;
  }
  return fs.existsSync(path.join(rootDir, "skills")) ? ["skills"] : [];
}

function resolveCodexHookDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  const declared = normalizeBundlePathList(raw.hooks);
  if (declared.length > 0) {
    return declared;
  }
  return fs.existsSync(path.join(rootDir, "hooks")) ? ["hooks"] : [];
}

function resolveCursorSkillsRootDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  const declared = normalizeBundlePathList(raw.skills);
  const defaults = fs.existsSync(path.join(rootDir, "skills")) ? ["skills"] : [];
  return mergeBundlePathLists(defaults, declared);
}

function resolveCursorCommandRootDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  const declared = normalizeBundlePathList(raw.commands);
  const defaults = fs.existsSync(path.join(rootDir, ".cursor", "commands"))
    ? [".cursor/commands"]
    : [];
  return mergeBundlePathLists(defaults, declared);
}

function resolveCursorSkillDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  return mergeBundlePathLists(
    resolveCursorSkillsRootDirs(raw, rootDir),
    resolveCursorCommandRootDirs(raw, rootDir),
  );
}

function resolveCursorAgentDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  const declared = normalizeBundlePathList(raw.subagents ?? raw.agents);
  const defaults = fs.existsSync(path.join(rootDir, ".cursor", "agents")) ? [".cursor/agents"] : [];
  return mergeBundlePathLists(defaults, declared);
}

function hasCursorHookCapability(raw: Record<string, unknown>, rootDir: string): boolean {
  return (
    hasInlineCapabilityValue(raw.hooks) ||
    fs.existsSync(path.join(rootDir, ".cursor", "hooks.json"))
  );
}

function hasCursorRulesCapability(raw: Record<string, unknown>, rootDir: string): boolean {
  return (
    hasInlineCapabilityValue(raw.rules) || fs.existsSync(path.join(rootDir, ".cursor", "rules"))
  );
}

function hasCursorMcpCapability(raw: Record<string, unknown>, rootDir: string): boolean {
  return hasInlineCapabilityValue(raw.mcpServers) || fs.existsSync(path.join(rootDir, ".mcp.json"));
}

function resolveClaudeComponentPaths(
  raw: Record<string, unknown>,
  key: string,
  rootDir: string,
  defaults: string[],
): string[] {
  const declared = normalizeBundlePathList(raw[key]);
  const existingDefaults = defaults.filter((candidate) =>
    fs.existsSync(path.join(rootDir, candidate)),
  );
  return mergeBundlePathLists(existingDefaults, declared);
}

function resolveClaudeSkillsRootDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "skills", rootDir, ["skills"]);
}

function resolveClaudeCommandRootDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "commands", rootDir, ["commands"]);
}

function resolveClaudeSkillDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  return mergeBundlePathLists(
    resolveClaudeSkillsRootDirs(raw, rootDir),
    resolveClaudeCommandRootDirs(raw, rootDir),
    resolveClaudeAgentDirs(raw, rootDir),
    resolveClaudeOutputStylePaths(raw, rootDir),
  );
}

function resolveClaudeAgentDirs(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "agents", rootDir, ["agents"]);
}

function resolveClaudeHookPaths(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "hooks", rootDir, ["hooks/hooks.json"]);
}

function resolveClaudeMcpPaths(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "mcpServers", rootDir, [".mcp.json"]);
}

function resolveClaudeLspPaths(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "lspServers", rootDir, [".lsp.json"]);
}

function resolveClaudeOutputStylePaths(raw: Record<string, unknown>, rootDir: string): string[] {
  return resolveClaudeComponentPaths(raw, "outputStyles", rootDir, ["output-styles"]);
}

function resolveClaudeSettingsFiles(_raw: Record<string, unknown>, rootDir: string): string[] {
  return fs.existsSync(path.join(rootDir, "settings.json")) ? ["settings.json"] : [];
}

function hasClaudeHookCapability(raw: Record<string, unknown>, rootDir: string): boolean {
  return hasInlineCapabilityValue(raw.hooks) || resolveClaudeHookPaths(raw, rootDir).length > 0;
}

function buildCodexCapabilities(raw: Record<string, unknown>, rootDir: string): string[] {
  const capabilities: string[] = [];
  if (resolveCodexSkillDirs(raw, rootDir).length > 0) {
    capabilities.push("skills");
  }
  if (resolveCodexHookDirs(raw, rootDir).length > 0) {
    capabilities.push("hooks");
  }
  if (hasInlineCapabilityValue(raw.mcpServers) || fs.existsSync(path.join(rootDir, ".mcp.json"))) {
    capabilities.push("mcpServers");
  }
  if (hasInlineCapabilityValue(raw.apps) || fs.existsSync(path.join(rootDir, ".app.json"))) {
    capabilities.push("apps");
  }
  return capabilities;
}

function buildClaudeCapabilities(raw: Record<string, unknown>, rootDir: string): string[] {
  const capabilities: string[] = [];
  if (resolveClaudeSkillDirs(raw, rootDir).length > 0) {
    capabilities.push("skills");
  }
  if (resolveClaudeCommandRootDirs(raw, rootDir).length > 0) {
    capabilities.push("commands");
  }
  if (resolveClaudeAgentDirs(raw, rootDir).length > 0) {
    capabilities.push("agents");
  }
  if (hasClaudeHookCapability(raw, rootDir)) {
    capabilities.push("hooks");
  }
  if (hasInlineCapabilityValue(raw.mcpServers) || resolveClaudeMcpPaths(raw, rootDir).length > 0) {
    capabilities.push("mcpServers");
  }
  if (hasInlineCapabilityValue(raw.lspServers) || resolveClaudeLspPaths(raw, rootDir).length > 0) {
    capabilities.push("lspServers");
  }
  if (
    hasInlineCapabilityValue(raw.outputStyles) ||
    resolveClaudeOutputStylePaths(raw, rootDir).length > 0
  ) {
    capabilities.push("outputStyles");
  }
  if (resolveClaudeSettingsFiles(raw, rootDir).length > 0) {
    capabilities.push("settings");
  }
  return capabilities;
}

function buildCursorCapabilities(raw: Record<string, unknown>, rootDir: string): string[] {
  const capabilities: string[] = [];
  if (resolveCursorSkillDirs(raw, rootDir).length > 0) {
    capabilities.push("skills");
  }
  if (resolveCursorCommandRootDirs(raw, rootDir).length > 0) {
    capabilities.push("commands");
  }
  if (resolveCursorAgentDirs(raw, rootDir).length > 0) {
    capabilities.push("agents");
  }
  if (hasCursorHookCapability(raw, rootDir)) {
    capabilities.push("hooks");
  }
  if (hasCursorRulesCapability(raw, rootDir)) {
    capabilities.push("rules");
  }
  if (hasCursorMcpCapability(raw, rootDir)) {
    capabilities.push("mcpServers");
  }
  return capabilities;
}

async function resolveCodexSkillDirsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  const declared = normalizeBundlePathList(raw.skills);
  if (declared.length > 0) {
    return declared;
  }
  return (await bundlePathExists(rootDir, "skills")) ? ["skills"] : [];
}

async function resolveCodexHookDirsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  const declared = normalizeBundlePathList(raw.hooks);
  if (declared.length > 0) {
    return declared;
  }
  return (await bundlePathExists(rootDir, "hooks")) ? ["hooks"] : [];
}

async function resolveCursorSkillsRootDirsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  const declared = normalizeBundlePathList(raw.skills);
  const defaults = (await bundlePathExists(rootDir, "skills")) ? ["skills"] : [];
  return mergeBundlePathLists(defaults, declared);
}

async function resolveCursorCommandRootDirsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  const declared = normalizeBundlePathList(raw.commands);
  const defaults = (await bundlePathExists(rootDir, ".cursor", "commands"))
    ? [".cursor/commands"]
    : [];
  return mergeBundlePathLists(defaults, declared);
}

async function resolveCursorSkillDirsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  return mergeBundlePathLists(
    await resolveCursorSkillsRootDirsAsync(raw, rootDir),
    await resolveCursorCommandRootDirsAsync(raw, rootDir),
  );
}

async function resolveCursorAgentDirsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  const declared = normalizeBundlePathList(raw.subagents ?? raw.agents);
  const defaults = (await bundlePathExists(rootDir, ".cursor", "agents")) ? [".cursor/agents"] : [];
  return mergeBundlePathLists(defaults, declared);
}

async function hasCursorHookCapabilityAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<boolean> {
  return (
    hasInlineCapabilityValue(raw.hooks) ||
    (await bundlePathExists(rootDir, ".cursor", "hooks.json"))
  );
}

async function hasCursorRulesCapabilityAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<boolean> {
  return (
    hasInlineCapabilityValue(raw.rules) || (await bundlePathExists(rootDir, ".cursor", "rules"))
  );
}

async function hasCursorMcpCapabilityAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<boolean> {
  return hasInlineCapabilityValue(raw.mcpServers) || (await bundlePathExists(rootDir, ".mcp.json"));
}

async function resolveClaudeComponentPathsAsync(
  raw: Record<string, unknown>,
  key: string,
  rootDir: string,
  defaults: string[],
): Promise<string[]> {
  const declared = normalizeBundlePathList(raw[key]);
  const existingDefaults: string[] = [];
  for (const candidate of defaults) {
    if (await bundleChildExists(rootDir, candidate)) {
      existingDefaults.push(candidate);
    }
  }
  return mergeBundlePathLists(existingDefaults, declared);
}

async function resolveClaudeSkillsRootDirsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  return resolveClaudeComponentPathsAsync(raw, "skills", rootDir, ["skills"]);
}

async function resolveClaudeCommandRootDirsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  return resolveClaudeComponentPathsAsync(raw, "commands", rootDir, ["commands"]);
}

async function resolveClaudeAgentDirsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  return resolveClaudeComponentPathsAsync(raw, "agents", rootDir, ["agents"]);
}

async function resolveClaudeHookPathsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  return resolveClaudeComponentPathsAsync(raw, "hooks", rootDir, ["hooks/hooks.json"]);
}

async function resolveClaudeMcpPathsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  return resolveClaudeComponentPathsAsync(raw, "mcpServers", rootDir, [".mcp.json"]);
}

async function resolveClaudeLspPathsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  return resolveClaudeComponentPathsAsync(raw, "lspServers", rootDir, [".lsp.json"]);
}

async function resolveClaudeOutputStylePathsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  return resolveClaudeComponentPathsAsync(raw, "outputStyles", rootDir, ["output-styles"]);
}

async function resolveClaudeSettingsFilesAsync(
  _raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  return (await bundlePathExists(rootDir, "settings.json")) ? ["settings.json"] : [];
}

async function resolveClaudeSkillDirsAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  return mergeBundlePathLists(
    await resolveClaudeSkillsRootDirsAsync(raw, rootDir),
    await resolveClaudeCommandRootDirsAsync(raw, rootDir),
    await resolveClaudeAgentDirsAsync(raw, rootDir),
    await resolveClaudeOutputStylePathsAsync(raw, rootDir),
  );
}

async function hasClaudeHookCapabilityAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<boolean> {
  return (
    hasInlineCapabilityValue(raw.hooks) ||
    (await resolveClaudeHookPathsAsync(raw, rootDir)).length > 0
  );
}

async function buildCodexCapabilitiesAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  const capabilities: string[] = [];
  if ((await resolveCodexSkillDirsAsync(raw, rootDir)).length > 0) {
    capabilities.push("skills");
  }
  if ((await resolveCodexHookDirsAsync(raw, rootDir)).length > 0) {
    capabilities.push("hooks");
  }
  if (hasInlineCapabilityValue(raw.mcpServers) || (await bundlePathExists(rootDir, ".mcp.json"))) {
    capabilities.push("mcpServers");
  }
  if (hasInlineCapabilityValue(raw.apps) || (await bundlePathExists(rootDir, ".app.json"))) {
    capabilities.push("apps");
  }
  return capabilities;
}

async function buildClaudeCapabilitiesAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  const capabilities: string[] = [];
  if ((await resolveClaudeSkillDirsAsync(raw, rootDir)).length > 0) {
    capabilities.push("skills");
  }
  if ((await resolveClaudeCommandRootDirsAsync(raw, rootDir)).length > 0) {
    capabilities.push("commands");
  }
  if ((await resolveClaudeAgentDirsAsync(raw, rootDir)).length > 0) {
    capabilities.push("agents");
  }
  if (await hasClaudeHookCapabilityAsync(raw, rootDir)) {
    capabilities.push("hooks");
  }
  if (
    hasInlineCapabilityValue(raw.mcpServers) ||
    (await resolveClaudeMcpPathsAsync(raw, rootDir)).length > 0
  ) {
    capabilities.push("mcpServers");
  }
  if (
    hasInlineCapabilityValue(raw.lspServers) ||
    (await resolveClaudeLspPathsAsync(raw, rootDir)).length > 0
  ) {
    capabilities.push("lspServers");
  }
  if (
    hasInlineCapabilityValue(raw.outputStyles) ||
    (await resolveClaudeOutputStylePathsAsync(raw, rootDir)).length > 0
  ) {
    capabilities.push("outputStyles");
  }
  if ((await resolveClaudeSettingsFilesAsync(raw, rootDir)).length > 0) {
    capabilities.push("settings");
  }
  return capabilities;
}

async function buildCursorCapabilitiesAsync(
  raw: Record<string, unknown>,
  rootDir: string,
): Promise<string[]> {
  const capabilities: string[] = [];
  if ((await resolveCursorSkillDirsAsync(raw, rootDir)).length > 0) {
    capabilities.push("skills");
  }
  if ((await resolveCursorCommandRootDirsAsync(raw, rootDir)).length > 0) {
    capabilities.push("commands");
  }
  if ((await resolveCursorAgentDirsAsync(raw, rootDir)).length > 0) {
    capabilities.push("agents");
  }
  if (await hasCursorHookCapabilityAsync(raw, rootDir)) {
    capabilities.push("hooks");
  }
  if (await hasCursorRulesCapabilityAsync(raw, rootDir)) {
    capabilities.push("rules");
  }
  if (await hasCursorMcpCapabilityAsync(raw, rootDir)) {
    capabilities.push("mcpServers");
  }
  return capabilities;
}

async function normalizeLoadedBundleManifestAsync(
  loaded: { manifestPath: string; raw: Record<string, unknown> },
  params: {
    rootDir: string;
    bundleFormat: PluginBundleFormat;
  },
): Promise<BundleManifestLoadResult> {
  const raw = loaded.raw;
  const interfaceRecord = isRecord(raw.interface) ? raw.interface : undefined;
  const name = normalizeOptionalString(raw.name);
  const description =
    normalizeOptionalString(raw.description) ??
    normalizeOptionalString(raw.shortDescription) ??
    normalizeOptionalString(interfaceRecord?.shortDescription);
  const version = normalizeOptionalString(raw.version);

  if (params.bundleFormat === "codex") {
    const skills = await resolveCodexSkillDirsAsync(raw, params.rootDir);
    const hooks = await resolveCodexHookDirsAsync(raw, params.rootDir);
    return {
      ok: true,
      manifest: {
        id: slugifyPluginId(name, params.rootDir),
        name,
        description,
        version,
        skills,
        settingsFiles: [],
        hooks,
        bundleFormat: "codex",
        capabilities: await buildCodexCapabilitiesAsync(raw, params.rootDir),
      },
      manifestPath: loaded.manifestPath,
    };
  }

  if (params.bundleFormat === "cursor") {
    return {
      ok: true,
      manifest: {
        id: slugifyPluginId(name, params.rootDir),
        name,
        description,
        version,
        skills: await resolveCursorSkillDirsAsync(raw, params.rootDir),
        settingsFiles: [],
        hooks: [],
        bundleFormat: "cursor",
        capabilities: await buildCursorCapabilitiesAsync(raw, params.rootDir),
      },
      manifestPath: loaded.manifestPath,
    };
  }

  return {
    ok: true,
    manifest: {
      id: slugifyPluginId(name, params.rootDir),
      name,
      description,
      version,
      skills: await resolveClaudeSkillDirsAsync(raw, params.rootDir),
      settingsFiles: await resolveClaudeSettingsFilesAsync(raw, params.rootDir),
      hooks: await resolveClaudeHookPathsAsync(raw, params.rootDir),
      bundleFormat: "claude",
      capabilities: await buildClaudeCapabilitiesAsync(raw, params.rootDir),
    },
    manifestPath: loaded.manifestPath,
  };
}

function normalizeLoadedBundleManifest(
  loaded: { manifestPath: string; raw: Record<string, unknown> },
  params: {
    rootDir: string;
    bundleFormat: PluginBundleFormat;
  },
): BundleManifestLoadResult {
  const raw = loaded.raw;
  const interfaceRecord = isRecord(raw.interface) ? raw.interface : undefined;
  const name = normalizeOptionalString(raw.name);
  const description =
    normalizeOptionalString(raw.description) ??
    normalizeOptionalString(raw.shortDescription) ??
    normalizeOptionalString(interfaceRecord?.shortDescription);
  const version = normalizeOptionalString(raw.version);

  if (params.bundleFormat === "codex") {
    const skills = resolveCodexSkillDirs(raw, params.rootDir);
    const hooks = resolveCodexHookDirs(raw, params.rootDir);
    return {
      ok: true,
      manifest: {
        id: slugifyPluginId(name, params.rootDir),
        name,
        description,
        version,
        skills,
        settingsFiles: [],
        hooks,
        bundleFormat: "codex",
        capabilities: buildCodexCapabilities(raw, params.rootDir),
      },
      manifestPath: loaded.manifestPath,
    };
  }

  if (params.bundleFormat === "cursor") {
    return {
      ok: true,
      manifest: {
        id: slugifyPluginId(name, params.rootDir),
        name,
        description,
        version,
        skills: resolveCursorSkillDirs(raw, params.rootDir),
        settingsFiles: [],
        hooks: [],
        bundleFormat: "cursor",
        capabilities: buildCursorCapabilities(raw, params.rootDir),
      },
      manifestPath: loaded.manifestPath,
    };
  }

  return {
    ok: true,
    manifest: {
      id: slugifyPluginId(name, params.rootDir),
      name,
      description,
      version,
      skills: resolveClaudeSkillDirs(raw, params.rootDir),
      settingsFiles: resolveClaudeSettingsFiles(raw, params.rootDir),
      hooks: resolveClaudeHookPaths(raw, params.rootDir),
      bundleFormat: "claude",
      capabilities: buildClaudeCapabilities(raw, params.rootDir),
    },
    manifestPath: loaded.manifestPath,
  };
}

export function loadBundleManifest(params: {
  rootDir: string;
  bundleFormat: PluginBundleFormat;
  rejectHardlinks?: boolean;
}): BundleManifestLoadResult {
  const rejectHardlinks = params.rejectHardlinks ?? true;
  const manifestRelativePath =
    params.bundleFormat === "codex"
      ? CODEX_BUNDLE_MANIFEST_RELATIVE_PATH
      : params.bundleFormat === "cursor"
        ? CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH
        : CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH;
  const loaded = loadBundleManifestFile({
    rootDir: params.rootDir,
    manifestRelativePath,
    rejectHardlinks,
    allowMissing: params.bundleFormat === "claude",
  });
  if (!loaded.ok) {
    return loaded;
  }

  return normalizeLoadedBundleManifest(loaded, params);
}

export async function loadBundleManifestAsync(params: {
  rootDir: string;
  bundleFormat: PluginBundleFormat;
  rejectHardlinks?: boolean;
}): Promise<BundleManifestLoadResult> {
  const rejectHardlinks = params.rejectHardlinks ?? true;
  const manifestRelativePath =
    params.bundleFormat === "codex"
      ? CODEX_BUNDLE_MANIFEST_RELATIVE_PATH
      : params.bundleFormat === "cursor"
        ? CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH
        : CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH;
  const loaded = await loadBundleManifestFileAsync({
    rootDir: params.rootDir,
    manifestRelativePath,
    rejectHardlinks,
    allowMissing: params.bundleFormat === "claude",
  });
  if (!loaded.ok) {
    return loaded;
  }

  return normalizeLoadedBundleManifestAsync(loaded, params);
}

export async function detectBundleManifestFormatAsync(
  rootDir: string,
): Promise<PluginBundleFormat | null> {
  if (await pathExistsAsync(path.join(rootDir, CODEX_BUNDLE_MANIFEST_RELATIVE_PATH))) {
    return "codex";
  }
  if (await pathExistsAsync(path.join(rootDir, CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH))) {
    return "cursor";
  }
  if (await pathExistsAsync(path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH))) {
    return "claude";
  }
  if (await pathExistsAsync(path.join(rootDir, PLUGIN_MANIFEST_FILENAME))) {
    return null;
  }
  const entryCandidates = await Promise.all(
    DEFAULT_PLUGIN_ENTRY_CANDIDATES.map((candidate) =>
      pathExistsAsync(path.join(rootDir, candidate)),
    ),
  );
  if (entryCandidates.some(Boolean)) {
    return null;
  }
  const manifestlessClaudeMarkers = [
    path.join(rootDir, "skills"),
    path.join(rootDir, "commands"),
    path.join(rootDir, "agents"),
    path.join(rootDir, "hooks", "hooks.json"),
    path.join(rootDir, ".mcp.json"),
    path.join(rootDir, ".lsp.json"),
    path.join(rootDir, "settings.json"),
  ];
  const markerHits = await Promise.all(
    manifestlessClaudeMarkers.map((candidate) => pathExistsAsync(candidate)),
  );
  if (markerHits.some(Boolean)) {
    return "claude";
  }
  return null;
}

export function detectBundleManifestFormat(rootDir: string): PluginBundleFormat | null {
  if (fs.existsSync(path.join(rootDir, CODEX_BUNDLE_MANIFEST_RELATIVE_PATH))) {
    return "codex";
  }
  if (fs.existsSync(path.join(rootDir, CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH))) {
    return "cursor";
  }
  if (fs.existsSync(path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH))) {
    return "claude";
  }
  if (fs.existsSync(path.join(rootDir, PLUGIN_MANIFEST_FILENAME))) {
    return null;
  }
  if (
    DEFAULT_PLUGIN_ENTRY_CANDIDATES.some((candidate) =>
      fs.existsSync(path.join(rootDir, candidate)),
    )
  ) {
    return null;
  }
  const manifestlessClaudeMarkers = [
    path.join(rootDir, "skills"),
    path.join(rootDir, "commands"),
    path.join(rootDir, "agents"),
    path.join(rootDir, "hooks", "hooks.json"),
    path.join(rootDir, ".mcp.json"),
    path.join(rootDir, ".lsp.json"),
    path.join(rootDir, "settings.json"),
  ];
  if (manifestlessClaudeMarkers.some((candidate) => fs.existsSync(candidate))) {
    return "claude";
  }
  return null;
}
