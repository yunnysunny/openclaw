import fs from "node:fs";

export const existsSync = fs.existsSync.bind(fs);
export const readFileSync = fs.readFileSync.bind(fs);
export const statSync = fs.statSync.bind(fs);
export const realpathSync = fs.realpathSync.bind(fs);

export async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export const readFile = fs.promises.readFile.bind(fs.promises);
export const realpath = fs.promises.realpath.bind(fs.promises);
