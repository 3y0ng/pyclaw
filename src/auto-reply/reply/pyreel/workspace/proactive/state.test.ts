import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../../../config/config.js";
import { buildTestCtx } from "../../../test-ctx.js";
import {
  allowProactiveTarget,
  evaluateProactiveGuard,
  loadProactiveState,
  markProactivePosted,
  proactiveFeatureEnabled,
  saveProactiveState,
  setProactiveEnabled,
  setProactiveQuietHours,
  setProactiveSchedule,
} from "./state.js";

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
  it("requires mode + proactive feature + proactive enabled flags", async () => {
    const cfg = {
      pyreel: {
        mode: true,
        features: { proactive: false },
        proactive: { enabled: true },
      },
    } as OpenClawConfig;
    expect(proactiveFeatureEnabled(cfg)).toBe(false);
  });

  it("persists proactive controls into stable JSON fields", async () => {
    const workspaceDir = await createWorkspace();

    await setProactiveEnabled(workspaceDir, false);
    await setProactiveSchedule(workspaceDir, "weekly");
    await allowProactiveTarget({ workspaceDir, target: "identity", value: "Slack:Admin" });
    await allowProactiveTarget({ workspaceDir, target: "surface", value: "Slack" });
    await setProactiveQuietHours(workspaceDir, { startHour: 22, endHour: 6 });

    const state = await loadProactiveState(workspaceDir);
    expect(state.enabled).toBe(false);
    expect(state.scheduleKind).toBe("weekly");
    expect(state.allowlist.identities).toEqual(["slack:admin"]);
    expect(state.allowlist.surfaces).toEqual(["slack"]);
    expect(state.quietHours).toEqual({ startHour: 22, endHour: 6 });

    const statePath = path.join(workspaceDir, "pyreel", "workspace", "state.json");
    const raw = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({
      version: 2,
      enabled: false,
      scheduleKind: "weekly",
      allowlist: {
        identities: ["slack:admin"],
        surfaces: ["slack"],
      },
      quietHours: { startHour: 22, endHour: 6 },
      rateLimits: null,
    });
  });

  it("blocks execution when config gate disables proactive", async () => {
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

  it("blocks execution when persisted proactive enabled flag is off", async () => {
    const workspaceDir = await createWorkspace();
    await setProactiveEnabled(workspaceDir, false);
    const decision = await evaluateProactiveGuard({
      cfg: {
        pyreel: { mode: true, features: { proactive: true }, proactive: { enabled: true } },
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

  it("preserves idempotency for weekly reports", async () => {
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
      kind: "weekly",
      now: new Date("2026-01-12T10:00:00.000Z"),
    });
    expect(first.allowed).toBe(true);
    if (!first.allowed) {
      return;
    }

    await markProactivePosted({
      workspaceDir,
      state: first.state,
      kind: "weekly",
      now: new Date("2026-01-12T10:00:00.000Z"),
    });

    const second = await evaluateProactiveGuard({
      cfg,
      ctx,
      workspaceDir,
      kind: "weekly",
      now: new Date("2026-01-13T12:00:00.000Z"),
    });
    expect(second.allowed).toBe(false);
    if (!second.allowed) {
      expect(second.reason).toBe("already_posted");
    }
  });

  it("preserves per-day rate limit checks", async () => {
    const workspaceDir = await createWorkspace();
    await saveProactiveState(workspaceDir, {
      version: 2,
      enabled: true,
      scheduleKind: "daily",
      allowlist: { identities: [], surfaces: [] },
      quietHours: null,
      rateLimits: { perHour: 10, perDay: 1 },
      counters: {
        hourWindowKey: "2026-01-12T11",
        dayWindowKey: "2026-01-12",
        hourCount: 1,
        dayCount: 1,
      },
      postedReports: { daily: "", weekly: "" },
    });

    const decision = await evaluateProactiveGuard({
      cfg: {
        pyreel: { mode: true, features: { proactive: true }, proactive: { enabled: true } },
      } as OpenClawConfig,
      ctx: buildTestCtx({ Surface: "slack", SenderId: "operator" }),
      workspaceDir,
      kind: "daily",
      now: new Date("2026-01-12T11:30:00.000Z"),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("rate_limit_day");
    }
  });
});
