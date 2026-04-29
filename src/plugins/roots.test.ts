import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledPluginsDir, resolveBundledPluginsDirAsync } from "./bundled-dir.js";

describe("plugin roots resolvers", () => {
  it("resolves sync roots and cache inputs", async () => {
    const { resolvePluginSourceRoots, resolvePluginCacheInputs } =
      (await import("./roots.js")) as typeof import("./roots.js");
    const env = { ...process.env };
    const roots = resolvePluginSourceRoots({
      workspaceDir: "/repo/workspace",
      env,
    });
    const stock = resolveBundledPluginsDir(env);
    expect(roots.stock).toBe(stock);
    expect(roots.global.endsWith(path.join(".openclaw", "extensions"))).toBe(true);
    expect(roots.workspace).toBe(path.join(path.resolve("/repo/workspace"), ".openclaw", "extensions"));

    const inputs = resolvePluginCacheInputs({
      workspaceDir: "/repo/workspace",
      loadPaths: [" ./foo ", "", " ./bar "],
      env,
    });
    expect(inputs.roots).toEqual(roots);
    const expectedLoadBase = process.cwd();
    expect(inputs.loadPaths).toEqual([
      path.resolve(expectedLoadBase, "foo"),
      path.resolve(expectedLoadBase, "bar"),
    ]);
  });

  it("resolves async roots and cache inputs", async () => {
    const { resolvePluginSourceRootsAsync, resolvePluginCacheInputsAsync } =
      (await import("./roots.js")) as typeof import("./roots.js");
    const env = { ...process.env };
    const roots = await resolvePluginSourceRootsAsync({
      workspaceDir: "/repo/workspace",
      env,
    });
    const stock = await resolveBundledPluginsDirAsync(env);
    expect(roots.stock).toBe(stock);
    expect(roots.global.endsWith(path.join(".openclaw", "extensions"))).toBe(true);
    expect(roots.workspace).toBe(path.join(path.resolve("/repo/workspace"), ".openclaw", "extensions"));

    const inputs = await resolvePluginCacheInputsAsync({
      workspaceDir: "/repo/workspace",
      loadPaths: [" ./foo ", "", " ./bar "],
      env,
    });
    expect(inputs.roots).toEqual(roots);
    const expectedLoadBase = process.cwd();
    expect(inputs.loadPaths).toEqual([
      path.resolve(expectedLoadBase, "foo"),
      path.resolve(expectedLoadBase, "bar"),
    ]);
  });
});
