// Compat stub: branch's loader.ts imports these from this module path. Upstream
// removed the file in the 2026-04 plugin runtime refactor. Returning an empty
// install result is safe — bundled runtime deps are optional.

export type BundledRuntimeDepsEnsureResult = {
  installedSpecs: string[];
  retainSpecs: string[];
};

export type BundledRuntimeDepsInstallParams = {
  pluginId: string;
  pluginRoot: string;
  installRoot: string;
  missingSpecs: string[];
  installSpecs?: string[];
};

export function ensureBundledPluginRuntimeDeps(_params: {
  pluginId: string;
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
  config?: unknown;
  retainSpecs?: readonly string[];
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
}): BundledRuntimeDepsEnsureResult {
  return { installedSpecs: [], retainSpecs: [] };
}

export function resolveBundledRuntimeDependencyInstallRoot(pluginRoot: string): string {
  return pluginRoot;
}
