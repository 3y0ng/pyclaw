import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { routePyreelMessage } from "./pyreel-router.js";
import { buildTestCtx } from "./test-ctx.js";

const TEMP_DIRS: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyreel-router-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("routePyreelMessage", () => {
  it("passes through when pyreel mode is disabled", async () => {
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "hello" }),
      cfg: {} as OpenClawConfig,
    });

    expect(decision.path).toBe("passthrough");
    expect(decision.reason).toBe("pyreel_mode_disabled");
  });

  it("blocks non-/pyreel input when mode is enabled", async () => {
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "hello" }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
    });

    expect(decision.path).toBe("block");
    expect(decision.deniedReason).toBe("non_pyreel_input");
  });

  it("handles /pyreel status from shared command path", async () => {
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel status" }),
      cfg: {
        pyreel: { mode: true, features: { ingest: true, remix: false, export: true } },
      } as OpenClawConfig,
    });

    expect(decision.path).toBe("block");
    expect(decision.matchedCommand).toBe("status");
    if (decision.path === "block") {
      expect(decision.replyText).toContain("ingest=on");
      expect(decision.replyText).toContain("remix=off");
      expect(decision.replyText).toContain("export=on");
    }
  });

  it("denies disabled feature command", async () => {
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel remix" }),
      cfg: { pyreel: { mode: true, features: { remix: false } } } as OpenClawConfig,
    });

    expect(decision.path).toBe("block");
    expect(decision.matchedCommand).toBe("remix");
    expect(decision.deniedReason).toBe("feature_disabled");
  });

  it("enforces global write flag for /pyreel apply", async () => {
    const workspaceDir = await createWorkspace();
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({
        BodyForCommands: "/pyreel apply --dry-run update clips",
        Surface: "slack",
      }),
      cfg: { pyreel: { mode: true, writes: { enabled: false } } } as OpenClawConfig,
      workspaceDir,
    });

    expect(decision.path).toBe("block");
    expect(decision.matchedCommand).toBe("apply");
    expect(decision.deniedReason).toBe("write_disabled");
  });

  it("enforces per-platform write flag for workflows", async () => {
    const workspaceDir = await createWorkspace();
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel brief launch ad", Surface: "slack" }),
      cfg: {
        pyreel: { mode: true, writes: { enabled: true, platforms: { slack: false } } },
      } as OpenClawConfig,
      workspaceDir,
    });

    expect(decision.path).toBe("block");
    expect(decision.matchedCommand).toBe("brief");
    expect(decision.deniedReason).toBe("write_disabled");
  });

  it("skips proactive reports when proactive gates are disabled", async () => {
    const workspaceDir = await createWorkspace();
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel proactive daily", Surface: "slack" }),
      cfg: {
        pyreel: { mode: true, features: { proactive: false }, proactive: { enabled: false } },
      } as OpenClawConfig,
      workspaceDir,
    });

    expect(decision.path).toBe("block");
    expect(decision.matchedCommand).toBe("proactive");
    expect(decision.deniedReason).toBe("proactive_disabled");

    const artifactsDir = path.join(workspaceDir, ".pyreel", "artifacts");
    await expect(fs.stat(artifactsDir)).rejects.toThrow();
  });

  it("posts proactive daily report when gates are enabled", async () => {
    const workspaceDir = await createWorkspace();
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({
        BodyForCommands: "/pyreel proactive daily",
        Surface: "slack",
        SenderId: "operator-1",
      }),
      cfg: {
        pyreel: {
          mode: true,
          features: { proactive: true },
          proactive: { enabled: true },
        },
      } as OpenClawConfig,
      workspaceDir,
    });

    expect(decision.path).toBe("block");
    if (decision.path === "block") {
      expect(decision.replyText).toContain("proactive daily posted");
    }

    const statePath = path.join(workspaceDir, ".pyreel", "workspace", "state", "proactive.json");
    const rawState = await fs.readFile(statePath, "utf8");
    expect(rawState).toContain('"daily"');
  });

  it("keeps auto-apply default disabled", async () => {
    const workspaceDir = await createWorkspace();
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({
        BodyForCommands: "/pyreel apply --auto-apply tune campaign pacing",
        Surface: "slack",
      }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });

    expect(decision.path).toBe("block");
    expect(decision.matchedCommand).toBe("apply");
    expect(decision.deniedReason).toBe("write_disabled");
  });

  it("allows low-risk auto-apply when explicitly enabled", async () => {
    const workspaceDir = await createWorkspace();
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({
        BodyForCommands: "/pyreel apply --auto-apply tune campaign pacing",
        Surface: "slack",
      }),
      cfg: {
        pyreel: {
          mode: true,
          autoApply: { enabled: true, platforms: { slack: true } },
        },
      } as OpenClawConfig,
      workspaceDir,
    });

    expect(decision.path).toBe("block");
    if (decision.path === "block") {
      expect(decision.replyText).toContain("auto-applied successfully");
    }
  });

  it("supports dry-run plus confirmation apply flow", async () => {
    const workspaceDir = await createWorkspace();
    const dryRun = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel apply --dry-run adjust captions" }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });

    expect(dryRun.path).toBe("block");
    if (dryRun.path !== "block") {
      return;
    }

    const match = dryRun.replyText.match(/ChangeSet\s+(\S+)\. Confirm with .* (\d{6})\./);
    expect(match).toBeTruthy();
    const changesetId = match?.[1] ?? "";
    const code = match?.[2] ?? "";

    const apply = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: `/pyreel apply ${changesetId} ${code}` }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });

    expect(apply.path).toBe("block");
    if (apply.path === "block") {
      expect(apply.replyText).toContain("applied successfully");
    }
  });

  it("prevents applying a changeset twice", async () => {
    const workspaceDir = await createWorkspace();
    const dryRun = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel apply --dry-run generate final render" }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });
    if (dryRun.path !== "block") {
      return;
    }

    const match = dryRun.replyText.match(/ChangeSet\s+(\S+)\. Confirm with .* (\d{6})\./);
    expect(match).toBeTruthy();
    const changesetId = match?.[1] ?? "";
    const code = match?.[2] ?? "";

    const first = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: `/pyreel apply ${changesetId} ${code}` }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });
    expect(first.path).toBe("block");

    const second = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: `/pyreel apply ${changesetId} ${code}` }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });

    expect(second.path).toBe("block");
    if (second.path === "block") {
      expect(second.replyText).toContain("already_applied");
    }
  });
});

it("enforces minimum role for write commands", async () => {
  const workspaceDir = await createWorkspace();
  await fs.mkdir(path.join(workspaceDir, "pyreel", "workspace"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "pyreel", "workspace", "acl.json"),
    JSON.stringify({ version: 1, grants: [{ identity: "slack:user-1", role: "viewer" }] }, null, 2),
  );

  const decision = await routePyreelMessage({
    ctx: buildTestCtx({
      BodyForCommands: "/pyreel apply --dry-run update clips",
      Surface: "slack",
      SenderId: "user-1",
    }),
    cfg: { pyreel: { mode: true } } as OpenClawConfig,
    workspaceDir,
  });

  expect(decision.path).toBe("block");
  expect(decision.deniedReason).toBe("rbac_forbidden");
});

it("supports /pyreel whoami", async () => {
  const workspaceDir = await createWorkspace();
  await fs.mkdir(path.join(workspaceDir, "pyreel", "workspace"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "pyreel", "workspace", "acl.json"),
    JSON.stringify({ version: 1, grants: [{ identity: "telegram:42", role: "admin" }] }, null, 2),
  );

  const decision = await routePyreelMessage({
    ctx: buildTestCtx({
      BodyForCommands: "/pyreel whoami",
      Surface: "telegram",
      SenderId: "42",
    }),
    cfg: { pyreel: { mode: true } } as OpenClawConfig,
    workspaceDir,
  });

  expect(decision.path).toBe("block");
  expect(decision.matchedCommand).toBe("whoami");
  if (decision.path === "block") {
    expect(decision.replyText).toContain("role=admin");
  }
});

it("restricts /pyreel rbac list to admins", async () => {
  const workspaceDir = await createWorkspace();
  await fs.mkdir(path.join(workspaceDir, "pyreel", "workspace"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "pyreel", "workspace", "acl.json"),
    JSON.stringify({ version: 1, grants: [{ identity: "slack:bob", role: "editor" }] }, null, 2),
  );

  const denied = await routePyreelMessage({
    ctx: buildTestCtx({ BodyForCommands: "/pyreel rbac list", Surface: "slack", SenderId: "bob" }),
    cfg: { pyreel: { mode: true } } as OpenClawConfig,
    workspaceDir,
  });
  expect(denied.path).toBe("block");
  expect(denied.deniedReason).toBe("rbac_forbidden");

  await fs.writeFile(
    path.join(workspaceDir, "pyreel", "workspace", "acl.json"),
    JSON.stringify({ version: 1, grants: [{ identity: "slack:bob", role: "admin" }] }, null, 2),
  );

  const allowed = await routePyreelMessage({
    ctx: buildTestCtx({ BodyForCommands: "/pyreel rbac list", Surface: "slack", SenderId: "bob" }),
    cfg: { pyreel: { mode: true } } as OpenClawConfig,
    workspaceDir,
  });
  expect(allowed.path).toBe("block");
  expect(allowed.deniedReason).toBeNull();
  if (allowed.path === "block") {
    expect(allowed.replyText).toContain("grants=");
  }
});
