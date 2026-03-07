import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmAndApplyChangeSet,
  createDryRunChangeSet,
  loadChangeSet,
  resolveConfirmationExpiry,
  type PyreelPlatformWriteAdapter,
} from "./store.js";

const TEMP_DIRS: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pyreel-changesets-"));
  TEMP_DIRS.push(dir);
  return dir;
}

async function withEnv(
  vars: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("pyreel changeset store", () => {
  it("creates awaiting_confirmation changesets and appends audit events", async () => {
    const workspaceDir = await createWorkspace();
    const created = await createDryRunChangeSet({
      workspaceDir,
      request: "pause meta ads budget +20",
      confirmationTtlSeconds: 120,
    });

    expect(created.status).toBe("awaiting_confirmation");
    expect(created.confirmation?.code).toMatch(/^\d{6}$/);
    expect(created.analysis?.riskLevel).toBe("low");

    const loaded = await loadChangeSet(workspaceDir, created.id);
    expect(loaded?.id).toBe(created.id);

    const auditPath = `${workspaceDir}/pyreel/workspace/audit.jsonl`;
    const lines = (await fs.readFile(auditPath, "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects invalid confirmation code", async () => {
    const workspaceDir = await createWorkspace();
    const created = await createDryRunChangeSet({
      workspaceDir,
      request: "pause meta",
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
      request: "pause meta",
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
      `${workspaceDir}/pyreel/workspace/changesets/${created.id}.json`,
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

  it("enforces global write gate", async () => {
    await withEnv({ PYREEL_ENABLE_WRITES: "0" }, async () => {
      const workspaceDir = await createWorkspace();
      const created = await createDryRunChangeSet({
        workspaceDir,
        request: "pause meta",
        confirmationTtlSeconds: 120,
      });
      const result = await confirmAndApplyChangeSet({
        workspaceDir,
        changesetId: created.id,
        confirmationCode: created.confirmation?.code ?? "",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("writes_disabled");
      }
    });
  });

  it("enforces platform write gate", async () => {
    await withEnv({ PYREEL_ENABLE_META_WRITES: "0" }, async () => {
      const workspaceDir = await createWorkspace();
      const created = await createDryRunChangeSet({
        workspaceDir,
        request: "pause meta campaigns",
        confirmationTtlSeconds: 120,
      });
      const result = await confirmAndApplyChangeSet({
        workspaceDir,
        changesetId: created.id,
        confirmationCode: created.confirmation?.code ?? "",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("meta_writes_disabled");
      }
    });
  });

  it("keeps idempotency strict after apply", async () => {
    const workspaceDir = await createWorkspace();
    const created = await createDryRunChangeSet({
      workspaceDir,
      request: "pause meta",
      confirmationTtlSeconds: 120,
    });

    const first = await confirmAndApplyChangeSet({
      workspaceDir,
      changesetId: created.id,
      confirmationCode: created.confirmation?.code ?? "",
    });
    expect(first.ok).toBe(true);

    const second = await confirmAndApplyChangeSet({
      workspaceDir,
      changesetId: created.id,
      confirmationCode: created.confirmation?.code ?? "",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("already_applied");
    }
  });

  it("blocks medium/high risk from auto-apply", async () => {
    const workspaceDir = await createWorkspace();
    const created = await createDryRunChangeSet({
      workspaceDir,
      request: "delete meta campaigns",
      confirmationTtlSeconds: 120,
    });

    const result = await confirmAndApplyChangeSet({
      workspaceDir,
      changesetId: created.id,
      confirmationCode: created.confirmation?.code ?? "",
      autoApply: true,
      platformAdapters: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("auto_apply_risk_denied_medium_or_high");
    }
  });

  it("enforces max operations per apply cap", async () => {
    await withEnv({ PYREEL_MAX_OPERATIONS_PER_APPLY: "1" }, async () => {
      const workspaceDir = await createWorkspace();
      const created = await createDryRunChangeSet({
        workspaceDir,
        request: "pause meta and increase meta budget +1",
        confirmationTtlSeconds: 120,
      });
      const adapter: PyreelPlatformWriteAdapter = {
        platform: "meta",
        applyLowRiskUpdates: vi.fn(async () => {}),
      };
      const result = await confirmAndApplyChangeSet({
        workspaceDir,
        changesetId: created.id,
        confirmationCode: created.confirmation?.code ?? "",
        autoApply: true,
        platformAdapters: { meta: adapter },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("max_operations_per_apply_exceeded");
      }
    });
  });

  it("enforces max operations per day cap", async () => {
    await withEnv({ PYREEL_MAX_OPERATIONS_PER_DAY: "1" }, async () => {
      const workspaceDir = await createWorkspace();
      const first = await createDryRunChangeSet({
        workspaceDir,
        request: "pause meta",
        confirmationTtlSeconds: 120,
      });
      const adapter: PyreelPlatformWriteAdapter = {
        platform: "meta",
        applyLowRiskUpdates: vi.fn(async () => {}),
      };
      const firstResult = await confirmAndApplyChangeSet({
        workspaceDir,
        changesetId: first.id,
        confirmationCode: first.confirmation?.code ?? "",
        autoApply: true,
        platformAdapters: { meta: adapter },
      });
      expect(firstResult.ok).toBe(true);

      const second = await createDryRunChangeSet({
        workspaceDir,
        request: "enable meta",
        confirmationTtlSeconds: 120,
      });
      const secondResult = await confirmAndApplyChangeSet({
        workspaceDir,
        changesetId: second.id,
        confirmationCode: second.confirmation?.code ?? "",
        autoApply: true,
        platformAdapters: { meta: adapter },
      });
      expect(secondResult.ok).toBe(false);
      if (!secondResult.ok) {
        expect(secondResult.reason).toContain("max_operations_per_day_exceeded");
      }
    });
  });

  it("enforces max budget delta cap", async () => {
    await withEnv({ PYREEL_MAX_BUDGET_DELTA: "10" }, async () => {
      const workspaceDir = await createWorkspace();
      const created = await createDryRunChangeSet({
        workspaceDir,
        request: "increase meta budget +50",
        confirmationTtlSeconds: 120,
      });
      const adapter: PyreelPlatformWriteAdapter = {
        platform: "meta",
        applyLowRiskUpdates: vi.fn(async () => {}),
      };
      const result = await confirmAndApplyChangeSet({
        workspaceDir,
        changesetId: created.id,
        confirmationCode: created.confirmation?.code ?? "",
        autoApply: true,
        platformAdapters: { meta: adapter },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("max_budget_delta_exceeded");
      }
    });
  });

  it("routes low-risk operations to platform adapters", async () => {
    const workspaceDir = await createWorkspace();
    const created = await createDryRunChangeSet({
      workspaceDir,
      request: "pause meta and increase meta budget +5",
      confirmationTtlSeconds: 120,
    });

    const adapter: PyreelPlatformWriteAdapter = {
      platform: "meta",
      applyLowRiskUpdates: vi.fn(async () => {}),
    };
    const result = await confirmAndApplyChangeSet({
      workspaceDir,
      changesetId: created.id,
      confirmationCode: created.confirmation?.code ?? "",
      autoApply: true,
      platformAdapters: { meta: adapter },
    });

    expect(result.ok).toBe(true);
    expect(adapter.applyLowRiskUpdates).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous auto-apply operations to draft-only output", async () => {
    const workspaceDir = await createWorkspace();
    const created = await createDryRunChangeSet({
      workspaceDir,
      request: "pause or enable maybe",
      confirmationTtlSeconds: 120,
    });

    const result = await confirmAndApplyChangeSet({
      workspaceDir,
      changesetId: created.id,
      confirmationCode: created.confirmation?.code ?? "",
      autoApply: true,
      platformAdapters: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("auto_apply_risk_denied_medium_or_high");
    }
  });

  it("exposes deterministic TTL expiry helper", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(resolveConfirmationExpiry(now, 60)).toBe("2026-01-01T00:01:00.000Z");
  });

  it("rejects traversal in changeset ids", async () => {
    const workspaceDir = await createWorkspace();
    await expect(loadChangeSet(workspaceDir, "../escape")).rejects.toThrow(
      "relativePath cannot contain '..'",
    );
  });
});
