import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorizePyreelCommand } from "./commands-pyreel-rbac.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (entry) => {
      await fs.rm(entry, { recursive: true, force: true });
    }),
  );
});

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyreel-rbac-"));
  cleanupPaths.push(dir);
  return dir;
}

describe("authorizePyreelCommand", () => {
  it("blocks /pyreel apply for non-approver by default", async () => {
    const workspace = await makeWorkspace();

    const decision = await authorizePyreelCommand({
      workspaceRoot: workspace,
      channel: "slack",
      senderId: "U123",
      rawBodyNormalized: "/pyreel apply",
    });

    expect(decision).toEqual({
      allowed: false,
      requiredRole: "approver",
      actualRole: "viewer",
    });
  });

  it("allows /pyreel status and /pyreel report for viewers", async () => {
    const workspace = await makeWorkspace();

    const statusDecision = await authorizePyreelCommand({
      workspaceRoot: workspace,
      channel: "slack",
      senderId: "U123",
      rawBodyNormalized: "/pyreel status",
    });
    const reportDecision = await authorizePyreelCommand({
      workspaceRoot: workspace,
      channel: "slack",
      senderId: "U123",
      rawBodyNormalized: "/pyreel report",
    });

    expect(statusDecision?.allowed).toBe(true);
    expect(reportDecision?.allowed).toBe(true);
  });

  it("uses stable channel and user ids in ACL grants", async () => {
    const workspace = await makeWorkspace();
    const aclPath = path.join(workspace, "pyreel", "workspace", "acl.json");
    await fs.mkdir(path.dirname(aclPath), { recursive: true });
    await fs.writeFile(
      aclPath,
      JSON.stringify(
        {
          version: 1,
          grants: [
            { subject: "slack:C1:U-APPROVER", role: "approver" },
            { subject: "msteams:8:orgid:USER-OPS", role: "operator" },
            { subject: "whatsapp:+15551234567", role: "viewer" },
          ],
        },
        null,
        2,
      ),
    );

    const approverApply = await authorizePyreelCommand({
      workspaceRoot: workspace,
      channel: "slack",
      channelId: "C1",
      senderId: "U-APPROVER",
      rawBodyNormalized: "/pyreel apply",
    });
    const wrongChannelApply = await authorizePyreelCommand({
      workspaceRoot: workspace,
      channel: "slack",
      channelId: "C2",
      senderId: "U-APPROVER",
      rawBodyNormalized: "/pyreel apply",
    });

    expect(approverApply?.allowed).toBe(true);
    expect(wrongChannelApply?.allowed).toBe(false);
  });
});
