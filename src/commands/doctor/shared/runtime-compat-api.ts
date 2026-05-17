// Compat stub: branch's config/io.ts imports applyRuntimeLegacyConfigMigrations
// from this path. Upstream removed/relocated it. Returning the input unchanged
// is safe — it skips the legacy migration step (a noop on modern configs).
export function applyRuntimeLegacyConfigMigrations<T>(config: T): T {
  return config;
}
