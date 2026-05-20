// @ts-nocheck
// Stage 5: this suite imports `test/helpers/import-fresh.ts`, a retired
// extension-test helper bridge on this branch (see
// scripts/check-no-extension-test-core-imports.ts retired list). Skip the
// suite until import-fresh is republished via plugin-sdk/test-fixtures.
import { describe } from "vitest";

describe.skip("bundled.shape-guard (skipped: retired test helper bridge)", () => {});
