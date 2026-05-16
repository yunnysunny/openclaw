import fs from "node:fs/promises";

/** Testable seam: `vi.spyOn` cannot target ESM exports on `node:fs/promises`. */
export const webchatMediaFs = {
  stat: fs.stat.bind(fs),
  readFile: fs.readFile.bind(fs),
};
