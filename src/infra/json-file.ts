import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const JSON_FILE_MODE = 0o600;
const JSON_DIR_MODE = 0o700;

function trySetSecureMode(pathname: string) {
  try {
    fs.chmodSync(pathname, JSON_FILE_MODE);
  } catch {
    // best-effort on platforms without chmod support
  }
}

function trySyncDirectory(pathname: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.dirname(pathname), "r");
    fs.fsyncSync(fd);
  } catch {
    // best-effort; some platforms/filesystems do not support syncing directories.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function readSymlinkTargetPath(linkPath: string): string {
  const target = fs.readlinkSync(linkPath);
  return path.resolve(path.dirname(linkPath), target);
}

function resolveJsonWriteTarget(pathname: string): { targetPath: string; followsSymlink: boolean } {
  let currentPath = pathname;
  const visited = new Set<string>();
  let followsSymlink = false;

  for (;;) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return { targetPath: currentPath, followsSymlink };
    }

    if (!stat.isSymbolicLink()) {
      return { targetPath: currentPath, followsSymlink };
    }

    if (visited.has(currentPath)) {
      const err = new Error(
        `Too many symlink levels while resolving ${pathname}`,
      ) as NodeJS.ErrnoException;
      err.code = "ELOOP";
      throw err;
    }

    visited.add(currentPath);
    followsSymlink = true;
    currentPath = readSymlinkTargetPath(currentPath);
  }
}

function renameJsonFileWithFallback(tmpPath: string, pathname: string) {
  try {
    fs.renameSync(tmpPath, pathname);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not reliably support rename-based overwrite for existing files.
    if (code === "EPERM" || code === "EEXIST") {
      fs.copyFileSync(tmpPath, pathname);
      fs.rmSync(tmpPath, { force: true });
      return;
    }
    throw error;
  }
}

function writeTempJsonFile(pathname: string, payload: string) {
  const fd = fs.openSync(pathname, "w", JSON_FILE_MODE);
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- JSON loading helper lets callers ascribe the expected payload type.
export function loadJsonFile<T = unknown>(pathname: string): T | undefined {
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function readSymlinkTargetPathAsync(linkPath: string): Promise<string> {
  const target = await fsp.readlink(linkPath);
  return path.resolve(path.dirname(linkPath), target);
}

async function resolveJsonWriteTargetAsync(
  pathname: string,
): Promise<{ targetPath: string; followsSymlink: boolean }> {
  let currentPath = pathname;
  const visited = new Set<string>();
  let followsSymlink = false;

  for (;;) {
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return { targetPath: currentPath, followsSymlink };
    }

    if (!stat.isSymbolicLink()) {
      return { targetPath: currentPath, followsSymlink };
    }

    if (visited.has(currentPath)) {
      const err = new Error(
        `Too many symlink levels while resolving ${pathname}`,
      ) as NodeJS.ErrnoException;
      err.code = "ELOOP";
      throw err;
    }
    visited.add(currentPath);
    followsSymlink = true;
    currentPath = await readSymlinkTargetPathAsync(currentPath);
  }
}

function trySetSecureModeAsync(pathname: string) {
  return fsp.chmod(pathname, JSON_FILE_MODE).catch(() => {
    // best-effort on platforms without chmod support
  });
}

async function trySyncDirectoryAsync(pathname: string) {
  try {
    const handle = await fsp.open(path.dirname(pathname), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    // best-effort; some platforms/filesystems do not support syncing directories.
  }
}

async function renameJsonFileWithFallbackAsync(tmpPath: string, pathname: string) {
  try {
    await fsp.rename(tmpPath, pathname);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EEXIST") {
      await fsp.copyFile(tmpPath, pathname);
      await fsp.rm(tmpPath, { force: true });
      return;
    }
    throw error;
  }
}

async function writeTempJsonFileAsync(pathname: string, payload: string) {
  const handle = await fsp.open(pathname, "w", JSON_FILE_MODE);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function saveJsonFileAsync(pathname: string, data: unknown) {
  const { targetPath, followsSymlink } = await resolveJsonWriteTargetAsync(pathname);
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  if (!followsSymlink) {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: JSON_DIR_MODE });
  }
  try {
    await writeTempJsonFileAsync(tmpPath, payload);
    await trySetSecureModeAsync(tmpPath);
    await renameJsonFileWithFallbackAsync(tmpPath, targetPath);
    await trySetSecureModeAsync(targetPath);
    await trySyncDirectoryAsync(targetPath);
  } finally {
    try {
      await fsp.rm(tmpPath, { force: true });
    } catch {
      // best-effort cleanup when rename does not happen
    }
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const { targetPath, followsSymlink } = resolveJsonWriteTarget(pathname);
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  if (!followsSymlink) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: JSON_DIR_MODE });
  }
  try {
    writeTempJsonFile(tmpPath, payload);
    trySetSecureMode(tmpPath);
    renameJsonFileWithFallback(tmpPath, targetPath);
    trySetSecureMode(targetPath);
    trySyncDirectory(targetPath);
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup when rename does not happen
    }
  }
}
