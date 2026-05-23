// Compat stub: branch's safe-open-async.ts and boundary-file-read.ts import these
// from this path. Upstream removed the file in the 2026-05 fs-safe migration.
// Provide minimal runtime-correct implementations.
import fs from "node:fs";

export type SafeOpenSyncAllowedType = "file" | "directory";

export type SafeOpenSyncFailureReason = "path" | "io" | "validation";

export type SafeOpenSyncResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats }
  | { ok: false; reason: SafeOpenSyncFailureReason; error?: unknown };

export function sameFileIdentity(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function isExpectedPathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function isAllowedType(stat: fs.Stats, allowedType: SafeOpenSyncAllowedType): boolean {
  if (allowedType === "directory") {
    return stat.isDirectory();
  }
  return stat.isFile();
}

export function openVerifiedFileSync(params: {
  filePath: string;
  resolvedPath?: string;
  rejectPathSymlink?: boolean;
  rejectHardlinks?: boolean;
  maxBytes?: number;
  allowedType?: SafeOpenSyncAllowedType;
}): SafeOpenSyncResult {
  const allowedType = params.allowedType ?? "file";
  const constants = fs.constants;
  const openReadFlags =
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  let fd: number | null = null;
  try {
    if (params.rejectPathSymlink) {
      const candidateStat = fs.lstatSync(params.filePath);
      if (candidateStat.isSymbolicLink()) {
        return { ok: false, reason: "validation" };
      }
    }
    const realPath = params.resolvedPath ?? fs.realpathSync(params.filePath);
    const preOpenStat = fs.lstatSync(realPath);
    if (!isAllowedType(preOpenStat, allowedType)) {
      return { ok: false, reason: "validation" };
    }
    if (params.rejectHardlinks && preOpenStat.isFile() && preOpenStat.nlink > 1) {
      return { ok: false, reason: "validation" };
    }
    if (
      params.maxBytes !== undefined &&
      preOpenStat.isFile() &&
      preOpenStat.size > params.maxBytes
    ) {
      return { ok: false, reason: "validation" };
    }
    fd = fs.openSync(realPath, openReadFlags);
    const openedStat = fs.fstatSync(fd);
    if (!isAllowedType(openedStat, allowedType)) {
      return { ok: false, reason: "validation" };
    }
    if (params.rejectHardlinks && openedStat.isFile() && openedStat.nlink > 1) {
      return { ok: false, reason: "validation" };
    }
    if (params.maxBytes !== undefined && openedStat.isFile() && openedStat.size > params.maxBytes) {
      return { ok: false, reason: "validation" };
    }
    if (!sameFileIdentity(preOpenStat, openedStat)) {
      return { ok: false, reason: "validation" };
    }
    const opened = { ok: true as const, path: realPath, fd, stat: openedStat };
    fd = null;
    return opened;
  } catch (error) {
    if (isExpectedPathError(error)) {
      return { ok: false, reason: "path", error };
    }
    return { ok: false, reason: "io", error };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}
