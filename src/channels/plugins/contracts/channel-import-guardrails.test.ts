// @ts-nocheck
// Stage 5: the upstream `test/helpers/plugins/public-artifacts.ts` bridge is
// a retired extension-test helper on this branch (see
// scripts/check-no-extension-test-core-imports.ts retired list). Skip the
// guardrail suite until the helper is re-published via a plugin-sdk subpath.
import { describe } from "vitest";

describe.skip("channel-import guardrails (skipped: retired test helper bridge)", () => {});
