import fs from "node:fs";
import {
  sameFileIdentity,
  type SafeOpenSyncAllowedType,
  type SafeOpenSyncResult,
} from "./safe-open-sync.js";

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
  let handle: fs.FileHandle | null = null;
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

    handle = await fs.promises.open(realPath, openReadFlags);
    const openedStat = await handle.stat();
    if (!isAllowedType(openedStat, allowedType)) {
      await handle.close();
      handle = null;
      return { ok: false, reason: "validation" };
    }
    if (params.rejectHardlinks && openedStat.isFile() && openedStat.nlink > 1) {
      await handle.close();
      handle = null;
      return { ok: false, reason: "validation" };
    }
    if (
      params.maxBytes !== undefined &&
      openedStat.isFile() &&
      openedStat.size > params.maxBytes
    ) {
      await handle.close();
      handle = null;
      return { ok: false, reason: "validation" };
    }
    if (!sameFileIdentity(preOpenStat, openedStat)) {
      await handle.close();
      handle = null;
      return { ok: false, reason: "validation" };
    }

    const fdNum = handle.fd;
    handle = null;
    return { ok: true, path: realPath, fd: fdNum, stat: openedStat };
  } catch (error) {
    if (handle !== null) {
      await handle.close().catch(() => {});
      handle = null;
    }
    if (isExpectedPathError(error)) {
      return { ok: false, reason: "path", error };
    }
    return { ok: false, reason: "io", error };
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => {});
    }
  }
}
