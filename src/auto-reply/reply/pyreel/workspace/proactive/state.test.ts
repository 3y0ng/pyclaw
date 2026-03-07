import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../../../config/config.js";
import { buildTestCtx } from "../../../test-ctx.js";
import { evaluateProactiveGuard, markProactivePosted, proactiveFeatureEnabled } from "./state.js";

const TEMP_DIRS: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyreel-proactive-state-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("pyreel proactive state", () => {
  it("requires both mode and proactive feature flags", async () => {
    const cfg = {
      pyreel: {
        mode: true,
        features: { proactive: false },
        proactive: { enabled: true },
      },
    } as OpenClawConfig;
    expect(proactiveFeatureEnabled(cfg)).toBe(false);
  });

  it("blocks execution when proactive feature is disabled", async () => {
    const workspaceDir = await createWorkspace();
    const decision = await evaluateProactiveGuard({
      cfg: {
        pyreel: { mode: true, features: { proactive: false }, proactive: { enabled: false } },
      } as OpenClawConfig,
      ctx: buildTestCtx({ Surface: "slack", SenderId: "operator" }),
      workspaceDir,
      kind: "daily",
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("proactive_disabled");
    }
  });

  it("prevents duplicate execution in the same daily window", async () => {
    const workspaceDir = await createWorkspace();
    const cfg = {
      pyreel: {
        mode: true,
        features: { proactive: true },
        proactive: { enabled: true },
      },
    } as OpenClawConfig;
    const ctx = buildTestCtx({ Surface: "slack", SenderId: "operator" });

    const first = await evaluateProactiveGuard({
      cfg,
      ctx,
      workspaceDir,
      kind: "daily",
      now: new Date("2026-01-01T10:00:00.000Z"),
    });
    expect(first.allowed).toBe(true);
    if (!first.allowed) {
      return;
    }
    await markProactivePosted({
      workspaceDir,
      state: first.state,
      kind: "daily",
      now: new Date("2026-01-01T10:00:00.000Z"),
    });

    const second = await evaluateProactiveGuard({
      cfg,
      ctx,
      workspaceDir,
      kind: "daily",
      now: new Date("2026-01-01T18:00:00.000Z"),
    });
    expect(second.allowed).toBe(false);
    if (!second.allowed) {
      expect(second.reason).toBe("already_posted");
    }
  });
});
