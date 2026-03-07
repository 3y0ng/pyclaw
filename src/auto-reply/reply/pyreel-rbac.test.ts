import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addPyreelDeny, resolvePyreelAccess } from "./pyreel-rbac.js";
import { buildTestCtx } from "./test-ctx.js";

const TEMP_DIRS: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyreel-rbac-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("pyreel rbac identity and deny handling", () => {
  it("matches channel-scoped grants before unscoped entries", async () => {
    const workspaceDir = await createWorkspace();
    const aclPath = path.join(workspaceDir, "pyreel", "workspace", "acl.json");
    await fs.mkdir(path.dirname(aclPath), { recursive: true });
    await fs.writeFile(
      aclPath,
      JSON.stringify(
        {
          version: 1,
          grants: [
            { identity: "alice", role: "viewer" },
            { identity: "slack:alice", role: "admin" },
          ],
        },
        null,
        2,
      ),
    );

    const access = await resolvePyreelAccess({
      workspaceDir,
      ctx: buildTestCtx({
        Surface: "slack",
        SenderId: "alice",
        From: "slack:u123",
      }),
    });

    expect(access.role).toBe("admin");
    expect(access.matchedGrant?.identity).toBe("slack:alice");
  });

  it("applies deny precedence over grants", async () => {
    const workspaceDir = await createWorkspace();
    const aclPath = path.join(workspaceDir, "pyreel", "workspace", "acl.json");
    await fs.mkdir(path.dirname(aclPath), { recursive: true });
    await fs.writeFile(
      aclPath,
      JSON.stringify(
        {
          version: 1,
          grants: [{ identity: "slack:alice", role: "admin" }],
          denies: [{ identity: "slack:alice", reason: "blocked" }],
        },
        null,
        2,
      ),
    );

    const access = await resolvePyreelAccess({
      workspaceDir,
      ctx: buildTestCtx({ Surface: "slack", SenderId: "alice", From: "slack:u123" }),
    });

    expect(access.denied).toBe(true);
    expect(access.role).toBe("viewer");
    expect(access.matchedGrant).toBeNull();
  });

  it("writes deny entries to pyreel/workspace/acl.json", async () => {
    const workspaceDir = await createWorkspace();
    await addPyreelDeny({
      workspaceDir,
      identity: "telegram:1234",
      reason: "security",
    });

    const aclRaw = await fs.readFile(
      path.join(workspaceDir, "pyreel", "workspace", "acl.json"),
      "utf8",
    );
    const acl = JSON.parse(aclRaw) as {
      denies?: Array<{ identity: string; reason?: string }>;
    };

    expect(acl.denies).toEqual([{ identity: "telegram:1234", reason: "security" }]);
  });
});
