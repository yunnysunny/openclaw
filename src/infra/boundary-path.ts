import "./fs-safe-defaults.js";
export {
  ROOT_PATH_ALIAS_POLICIES,
  resolvePathViaExistingAncestorSync,
  resolveRootPath,
  resolveRootPathSync,
  type ResolvedRootPath,
  type RootPathAliasPolicy,
} from "@openclaw/fs-safe/advanced";

export const resolveBoundaryPathSync: (
  params: { absolutePath: string; rootPath: string; boundaryLabel?: string } | string,
) => string | null = (p) => (typeof p === "string" ? p : p.absolutePath);

