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

  it("supports /pyreel help", async () => {
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel help" }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
    });

    expect(decision.path).toBe("block");
    expect(decision.matchedCommand).toBe("help");
    if (decision.path === "block") {
      expect(decision.replyText).toContain(
        "/pyreel help|brief|plan|research|scripts|report|next|apply",
      );
    }
  });

  it("supports workflow actions", async () => {
    const workflowActions = ["brief", "plan", "research", "scripts", "report", "next"];
    for (const action of workflowActions) {
      const decision = await routePyreelMessage({
        ctx: buildTestCtx({ BodyForCommands: `/pyreel ${action} draft campaign` }),
        cfg: { pyreel: { mode: true } } as OpenClawConfig,
      });

      expect(decision.path).toBe("block");
      expect(decision.matchedCommand).toBe(action);
      if (decision.path === "block") {
        expect(decision.replyText).toContain(`Pyreel ${action} requires a workspace directory.`);
      }
    }
  });

  it("rejects legacy ingest/remix/export commands", async () => {
    const legacyCommands = ["ingest", "remix", "export"];
    for (const command of legacyCommands) {
      const decision = await routePyreelMessage({
        ctx: buildTestCtx({ BodyForCommands: `/pyreel ${command}` }),
        cfg: { pyreel: { mode: true } } as OpenClawConfig,
      });

      expect(decision.path).toBe("block");
      expect(decision.matchedCommand).toBeNull();
      expect(decision.deniedReason).toBe("unknown_command");
    }
  });

  it("supports /pyreel proactive on|off|status|allow|disallow|quiet-hours", async () => {
    const workspaceDir = await createWorkspace();
    const proactiveCommands = ["on", "off", "status", "allow", "disallow", "quiet-hours"];
    for (const subcommand of proactiveCommands) {
      const decision = await routePyreelMessage({
        ctx: buildTestCtx({ BodyForCommands: `/pyreel proactive ${subcommand}` }),
        cfg: { pyreel: { mode: true } } as OpenClawConfig,
        workspaceDir,
      });

      expect(decision.path).toBe("block");
      expect(decision.matchedCommand).toBe("proactive");
      if (decision.path === "block") {
        expect(decision.replyText).toContain(`Pyreel proactive ${subcommand}`);
      }
    }
  });

  it("supports /pyreel proactive schedule", async () => {
    const workspaceDir = await createWorkspace();
    const usageDecision = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel proactive schedule" }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });

    expect(usageDecision.path).toBe("block");
    expect(usageDecision.matchedCommand).toBe("proactive");
    if (usageDecision.path === "block") {
      expect(usageDecision.replyText).toContain("Usage: /pyreel proactive schedule <daily|weekly>");
    }

    const scheduledDecision = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel proactive schedule daily", Surface: "slack" }),
      cfg: {
        pyreel: { mode: true, features: { proactive: false }, proactive: { enabled: false } },
      } as OpenClawConfig,
      workspaceDir,
    });

    expect(scheduledDecision.path).toBe("block");
    expect(scheduledDecision.matchedCommand).toBe("proactive");
    expect(scheduledDecision.deniedReason).toBe("proactive_disabled");
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

  it("supports /pyreel rbac status|list|grant|revoke", async () => {
    const workspaceDir = await createWorkspace();
    await fs.mkdir(path.join(workspaceDir, "pyreel", "workspace"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "pyreel", "workspace", "acl.json"),
      JSON.stringify({ version: 1, grants: [{ identity: "slack:bob", role: "admin" }] }, null, 2),
    );

    const status = await routePyreelMessage({
      ctx: buildTestCtx({
        BodyForCommands: "/pyreel rbac status",
        Surface: "slack",
        SenderId: "bob",
      }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });
    expect(status.path).toBe("block");
    expect(status.matchedCommand).toBe("rbac_status");

    const list = await routePyreelMessage({
      ctx: buildTestCtx({
        BodyForCommands: "/pyreel rbac list",
        Surface: "slack",
        SenderId: "bob",
      }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });
    expect(list.path).toBe("block");
    expect(list.matchedCommand).toBe("rbac_list");

    const grant = await routePyreelMessage({
      ctx: buildTestCtx({
        BodyForCommands: "/pyreel rbac grant slack:alice editor",
        Surface: "slack",
        SenderId: "bob",
      }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });
    expect(grant.path).toBe("block");
    expect(grant.matchedCommand).toBe("rbac_grant");

    const revoke = await routePyreelMessage({
      ctx: buildTestCtx({
        BodyForCommands: "/pyreel rbac revoke slack:alice",
        Surface: "slack",
        SenderId: "bob",
      }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
      workspaceDir,
    });
    expect(revoke.path).toBe("block");
    expect(revoke.matchedCommand).toBe("rbac_revoke");
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

  it("falls back to help text for unknown commands", async () => {
    const decision = await routePyreelMessage({
      ctx: buildTestCtx({ BodyForCommands: "/pyreel mystery" }),
      cfg: { pyreel: { mode: true } } as OpenClawConfig,
    });

    expect(decision.path).toBe("block");
    expect(decision.matchedCommand).toBeNull();
    expect(decision.deniedReason).toBe("unknown_command");
    if (decision.path === "block") {
      expect(decision.replyText).toContain(
        "/pyreel proactive on|off|status|schedule|allow|disallow|quiet-hours",
      );
    }
  });
});
