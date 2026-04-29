import fs from "node:fs";
import { promisify } from "node:util";
import {
  sameFileIdentity,
  type SafeOpenSyncAllowedType,
  type SafeOpenSyncResult,
} from "./safe-open-sync.js";

const openAsync = promisify(fs.open);
const fstatAsync = promisify(fs.fstat);
const closeAsync = promisify(fs.close);

export type SafeOpenAsyncResult = SafeOpenSyncResult;

function isExpectedPathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function isAllowedType(stat: fs.Stats, allowedType: SafeOpenSyncAllowedType): boolean {
  if (allowedType === "directory") {
    return stat.isDirectory();
  }
  return stat.isFile();
}

/**
 * Async counterpart to `openVerifiedFileSync`, returning a **raw** OS file
 * descriptor. Uses `fs.open` (not `fs.promises.open` / `FileHandle`) so callers
 * can own the fd without a `FileHandle` finalizer also closing it on GC (which
 * caused EBADF / double-close when the numeric `fd` was used elsewhere).
 */
export async function openVerifiedFileAsync(params: {
  filePath: string;
  resolvedPath?: string;
  rejectPathSymlink?: boolean;
  rejectHardlinks?: boolean;
  maxBytes?: number;
  allowedType?: SafeOpenSyncAllowedType;
}): Promise<SafeOpenAsyncResult> {
  const allowedType = params.allowedType ?? "file";
  const constants = fs.constants;
  const openReadFlags =
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  let fd: number | null = null;
  try {
    if (params.rejectPathSymlink) {
      const candidateStat = await fs.promises.lstat(params.filePath);
      if (candidateStat.isSymbolicLink()) {
        return { ok: false, reason: "validation" };
      }
    }

    const realPath = params.resolvedPath ?? (await fs.promises.realpath(params.filePath));
    const preOpenStat = await fs.promises.lstat(realPath);
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

    fd = await openAsync(realPath, openReadFlags);
    const openedStat = await fstatAsync(fd);
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
      await closeAsync(fd).catch(() => {});
    }
  }
}
