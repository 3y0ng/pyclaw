import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  confirmAndApplyChangeSet,
  createDryRunChangeSet,
  loadChangeSet,
  resolveConfirmationExpiry,
} from "./store.js";

const TEMP_DIRS: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyreel-changesets-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("pyreel changeset store", () => {
  it("creates awaiting_confirmation changesets and appends audit events", async () => {
    const workspaceDir = await createWorkspace();
    const created = await createDryRunChangeSet({
      workspaceDir,
      request: "dry-run update",
      confirmationTtlSeconds: 120,
    });

    expect(created.status).toBe("awaiting_confirmation");
    expect(created.confirmation?.code).toMatch(/^\d{6}$/);

    const loaded = await loadChangeSet(workspaceDir, created.id);
    expect(loaded?.id).toBe(created.id);

    const auditPath = path.join(workspaceDir, ".pyreel", "workspace", "changesets", "audit.jsonl");
    const lines = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects invalid confirmation code", async () => {
    const workspaceDir = await createWorkspace();
    const created = await createDryRunChangeSet({
      workspaceDir,
      request: "dry-run invalid code",
      confirmationTtlSeconds: 120,
    });

    const result = await confirmAndApplyChangeSet({
      workspaceDir,
      changesetId: created.id,
      confirmationCode: "000000",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_confirmation_code");
    }
  });

  it("fails confirmation after TTL expiration", async () => {
    const workspaceDir = await createWorkspace();
    const created = await createDryRunChangeSet({
      workspaceDir,
      request: "dry-run expired",
      confirmationTtlSeconds: 1,
    });

    const loaded = await loadChangeSet(workspaceDir, created.id);
    if (!loaded?.confirmation) {
      throw new Error("missing confirmation");
    }

    const expired = {
      ...loaded,
      confirmation: {
        ...loaded.confirmation,
        expiresAt: new Date(Date.now() - 5_000).toISOString(),
      },
    };
    await fs.writeFile(
      path.join(workspaceDir, ".pyreel", "workspace", "changesets", `${created.id}.json`),
      `${JSON.stringify(expired, null, 2)}\n`,
      "utf8",
    );

    const result = await confirmAndApplyChangeSet({
      workspaceDir,
      changesetId: created.id,
      confirmationCode: loaded.confirmation.code,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("confirmation_expired");
    }
  });

  it("exposes deterministic TTL expiry helper", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(resolveConfirmationExpiry(now, 60)).toBe("2026-01-01T00:01:00.000Z");
  });
});
