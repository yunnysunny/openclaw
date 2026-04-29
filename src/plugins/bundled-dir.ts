import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveOpenClawPackageRoot,
  resolveOpenClawPackageRootSync,
} from "../infra/openclaw-root.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";

const DISABLED_BUNDLED_PLUGINS_DIR = path.join(os.tmpdir(), "openclaw-empty-bundled-plugins");

function bundledPluginsDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = normalizeOptionalLowercaseString(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS);
  return raw === "1" || raw === "true";
}

function resolveDisabledBundledPluginsDir(): string {
  fs.mkdirSync(DISABLED_BUNDLED_PLUGINS_DIR, { recursive: true });
  return DISABLED_BUNDLED_PLUGINS_DIR;
}

async function resolveDisabledBundledPluginsDirAsync(): Promise<string> {
  await fs.promises.mkdir(DISABLED_BUNDLED_PLUGINS_DIR, { recursive: true });
  return DISABLED_BUNDLED_PLUGINS_DIR;
}

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    fs.existsSync(path.join(packageRoot, ".git")) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isSourceCheckoutRootAsync(packageRoot: string): Promise<boolean> {
  const [hasGit, hasSrc, hasExtensions] = await Promise.all([
    pathExists(path.join(packageRoot, ".git")),
    pathExists(path.join(packageRoot, "src")),
    pathExists(path.join(packageRoot, "extensions")),
  ]);
  return hasGit && hasSrc && hasExtensions;
}

function hasUsableBundledPluginTree(pluginsDir: string): boolean {
  if (!fs.existsSync(pluginsDir)) {
    return false;
  }
  try {
    return fs.readdirSync(pluginsDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      const pluginDir = path.join(pluginsDir, entry.name);
      return (
        fs.existsSync(path.join(pluginDir, "package.json")) ||
        fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"))
      );
    });
  } catch {
    return false;
  }
}

async function hasUsableBundledPluginTreeAsync(pluginsDir: string): Promise<boolean> {
  if (!(await pathExists(pluginsDir))) {
    return false;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginDir = path.join(pluginsDir, entry.name);
    if (
      (await pathExists(path.join(pluginDir, "package.json"))) ||
      (await pathExists(path.join(pluginDir, "openclaw.plugin.json")))
    ) {
      return true;
    }
  }
  return false;
}

function runningSourceTypeScriptProcess(): boolean {
  const argv1 = process.argv[1]?.toLowerCase();
  if (
    argv1?.endsWith(".ts") ||
    argv1?.endsWith(".tsx") ||
    argv1?.endsWith(".mts") ||
    argv1?.endsWith(".cts")
  ) {
    return true;
  }

  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index]?.toLowerCase();
    if (!arg) {
      continue;
    }
    if (arg === "tsx" || arg.includes("tsx/register")) {
      return true;
    }
    if ((arg === "--import" || arg === "--loader") && process.execArgv[index + 1]) {
      const next = process.execArgv[index + 1].toLowerCase();
      if (next === "tsx" || next.includes("tsx/")) {
        return true;
      }
    }
  }

  return false;
}

function resolveBundledDirFromPackageRoot(
  packageRoot: string,
  preferSourceCheckout: boolean,
): string | undefined {
  const sourceExtensionsDir = path.join(packageRoot, "extensions");
  const builtExtensionsDir = path.join(packageRoot, "dist", "extensions");
  const sourceCheckout = isSourceCheckoutRoot(packageRoot);
  if (preferSourceCheckout && fs.existsSync(sourceExtensionsDir)) {
    return sourceExtensionsDir;
  }
  // Local source checkouts stage a runtime-complete bundled plugin tree under
  // dist-runtime/. Prefer that over source extensions only when the paired
  // dist/ tree exists; otherwise wrappers can drift ahead of the last build.
  const runtimeExtensionsDir = path.join(packageRoot, "dist-runtime", "extensions");
  const hasUsableRuntimeTree = sourceCheckout
    ? hasUsableBundledPluginTree(runtimeExtensionsDir)
    : fs.existsSync(runtimeExtensionsDir);
  const hasUsableBuiltTree = sourceCheckout
    ? hasUsableBundledPluginTree(builtExtensionsDir)
    : fs.existsSync(builtExtensionsDir);
  if (hasUsableRuntimeTree && hasUsableBuiltTree) {
    return runtimeExtensionsDir;
  }
  if (hasUsableBuiltTree) {
    return builtExtensionsDir;
  }
  if (sourceCheckout && fs.existsSync(sourceExtensionsDir)) {
    return sourceExtensionsDir;
  }
  return undefined;
}

async function resolveBundledDirFromPackageRootAsync(
  packageRoot: string,
  preferSourceCheckout: boolean,
): Promise<string | undefined> {
  const sourceExtensionsDir = path.join(packageRoot, "extensions");
  const builtExtensionsDir = path.join(packageRoot, "dist", "extensions");
  const sourceCheckout = await isSourceCheckoutRootAsync(packageRoot);
  if (preferSourceCheckout && (await pathExists(sourceExtensionsDir))) {
    return sourceExtensionsDir;
  }
  const runtimeExtensionsDir = path.join(packageRoot, "dist-runtime", "extensions");
  const hasUsableRuntimeTree = sourceCheckout
    ? await hasUsableBundledPluginTreeAsync(runtimeExtensionsDir)
    : await pathExists(runtimeExtensionsDir);
  const hasUsableBuiltTree = sourceCheckout
    ? await hasUsableBundledPluginTreeAsync(builtExtensionsDir)
    : await pathExists(builtExtensionsDir);
  if (hasUsableRuntimeTree && hasUsableBuiltTree) {
    return runtimeExtensionsDir;
  }
  if (hasUsableBuiltTree) {
    return builtExtensionsDir;
  }
  if (sourceCheckout && (await pathExists(sourceExtensionsDir))) {
    return sourceExtensionsDir;
  }
  return undefined;
}

export function resolveBundledPluginsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (bundledPluginsDisabled(env)) {
    return resolveDisabledBundledPluginsDir();
  }

  const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (override) {
    const resolvedOverride = resolveUserPath(override, env);
    if (fs.existsSync(resolvedOverride)) {
      return resolvedOverride;
    }
    // Installed CLIs can inherit stale bundled-dir overrides from older shells
    // or debug sessions. Prefer the package that owns argv[1] over a broken
    // override so bundled providers keep working in packaged installs.
    try {
      const argvPackageRoot = resolveOpenClawPackageRootSync({ argv1: process.argv[1] });
      if (argvPackageRoot && !isSourceCheckoutRoot(argvPackageRoot)) {
        const argvFallback = resolveBundledDirFromPackageRoot(argvPackageRoot, false);
        if (argvFallback) {
          return argvFallback;
        }
      }
    } catch {
      // ignore
    }
    return resolvedOverride;
  }

  const preferSourceCheckout = Boolean(env.VITEST) || runningSourceTypeScriptProcess();

  try {
    const packageRoots = [
      resolveOpenClawPackageRootSync({ argv1: process.argv[1] }),
      resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
      resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
    ].filter(
      (entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index,
    );
    for (const packageRoot of packageRoots) {
      const bundledDir = resolveBundledDirFromPackageRoot(packageRoot, preferSourceCheckout);
      if (bundledDir) {
        return bundledDir;
      }
    }
  } catch {
    // ignore
  }

  // bun --compile: ship a sibling bundled plugin tree next to the executable.
  try {
    const execDir = path.dirname(process.execPath);
    const siblingBuilt = path.join(execDir, "dist", "extensions");
    if (fs.existsSync(siblingBuilt)) {
      return siblingBuilt;
    }
    const sibling = path.join(execDir, "extensions");
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  // npm/dev: walk up from this module to find the bundled plugin tree at the package root.
  try {
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(cursor, "extensions");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }

  return undefined;
}

export async function resolveBundledPluginsDirAsync(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (bundledPluginsDisabled(env)) {
    return resolveDisabledBundledPluginsDirAsync();
  }

  const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (override) {
    const resolvedOverride = resolveUserPath(override, env);
    if (await pathExists(resolvedOverride)) {
      return resolvedOverride;
    }
    try {
      const argvPackageRoot = await resolveOpenClawPackageRoot({ argv1: process.argv[1] });
      if (argvPackageRoot && !(await isSourceCheckoutRootAsync(argvPackageRoot))) {
        const argvFallback = await resolveBundledDirFromPackageRootAsync(argvPackageRoot, false);
        if (argvFallback) {
          return argvFallback;
        }
      }
    } catch {
      // ignore
    }
    return resolvedOverride;
  }

  const preferSourceCheckout = Boolean(env.VITEST) || runningSourceTypeScriptProcess();

  try {
    const packageRoots = [
      await resolveOpenClawPackageRoot({ argv1: process.argv[1] }),
      await resolveOpenClawPackageRoot({ cwd: process.cwd() }),
      await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url }),
    ].filter((entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index);
    for (const packageRoot of packageRoots) {
      const bundledDir = await resolveBundledDirFromPackageRootAsync(packageRoot, preferSourceCheckout);
      if (bundledDir) {
        return bundledDir;
      }
    }
  } catch {
    // ignore
  }

  try {
    const execDir = path.dirname(process.execPath);
    const siblingBuilt = path.join(execDir, "dist", "extensions");
    if (await pathExists(siblingBuilt)) {
      return siblingBuilt;
    }
    const sibling = path.join(execDir, "extensions");
    if (await pathExists(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  try {
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(cursor, "extensions");
      if (await pathExists(candidate)) {
        return candidate;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }

  return undefined;
}
