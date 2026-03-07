import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePyreelWorkspaceFilePath,
  resolvePyreelWorkspacePath,
  resolvePyreelWorkspaceSubdirPath,
} from "../paths.js";
import type { ChangeSetAuditEvent, ChangeSetRecord, ChangeSetStatus } from "./model.js";

type PyreelPlatform = "meta" | "tiktok" | "google";
type LowRiskOperationKind = "pause" | "enable" | "budget";

type LowRiskOperation = {
  kind: LowRiskOperationKind;
  platform: PyreelPlatform;
  amount?: number;
};

export type PyreelPlatformWriteAdapter = {
  platform: PyreelPlatform;
  applyLowRiskUpdates: (operations: LowRiskOperation[]) => Promise<void>;
};

function changesetRoot(workspaceDir: string): string {
  return resolvePyreelWorkspaceSubdirPath(workspaceDir, "changesets");
}

function changesetPath(workspaceDir: string, changesetId: string): string {
  return resolvePyreelWorkspacePath(workspaceDir, `changesets/${changesetId}.json`);
}

function auditPath(workspaceDir: string): string {
  return resolvePyreelWorkspaceFilePath(workspaceDir, "audit.jsonl");
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function createConfirmationCode(): string {
  return Math.floor(100_000 + Math.random() * 900_000).toString();
}

function parseBooleanFlag(raw: string | undefined): boolean | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  return undefined;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function writeGateEnabled(): boolean {
  return parseBooleanFlag(process.env.PYREEL_ENABLE_WRITES) ?? true;
}

function platformWriteGateEnabled(platform: PyreelPlatform): boolean {
  const key =
    platform === "meta"
      ? "PYREEL_ENABLE_META_WRITES"
      : platform === "tiktok"
        ? "PYREEL_ENABLE_TIKTOK_WRITES"
        : "PYREEL_ENABLE_GOOGLE_WRITES";
  return parseBooleanFlag(process.env[key]) ?? true;
}

function resolvePlatformsFromRequest(request: string): PyreelPlatform[] {
  const normalized = request.toLowerCase();
  const platforms: PyreelPlatform[] = [];
  if (/\b(meta|facebook|instagram)\b/.test(normalized)) {
    platforms.push("meta");
  }
  if (/\b(tiktok|tt)\b/.test(normalized)) {
    platforms.push("tiktok");
  }
  if (/\b(google|googleads|adwords)\b/.test(normalized)) {
    platforms.push("google");
  }
  return platforms;
}

function resolveLowRiskOperations(
  request: string,
  platforms: PyreelPlatform[],
): LowRiskOperation[] {
  const normalized = request.toLowerCase();
  const operations: LowRiskOperation[] = [];

  const hasPause = /\b(pause|paused|stop)\b/.test(normalized);
  const hasEnable = /\b(enable|enabled|resume|start|unpause)\b/.test(normalized);

  if (hasPause) {
    for (const platform of platforms) {
      operations.push({ kind: "pause", platform });
    }
  }

  if (hasEnable) {
    for (const platform of platforms) {
      operations.push({ kind: "enable", platform });
    }
  }

  const budgetMatches = [...normalized.matchAll(/\bbudget\b[^\d+-]*([+-]?\d+(?:\.\d+)?)/g)];
  for (const match of budgetMatches) {
    const amount = Number.parseFloat(match[1] ?? "");
    if (!Number.isFinite(amount)) {
      continue;
    }
    for (const platform of platforms) {
      operations.push({ kind: "budget", platform, amount });
    }
  }

  return operations;
}

function analyzeDryRunRequest(request: string): NonNullable<ChangeSetRecord["analysis"]> {
  const normalized = request.trim().toLowerCase();
  const platforms = resolvePlatformsFromRequest(normalized);
  const lowRiskOperations = resolveLowRiskOperations(normalized, platforms);
  const budgetDelta = lowRiskOperations
    .filter((operation) => operation.kind === "budget")
    .reduce((sum, operation) => sum + Math.abs(operation.amount ?? 0), 0);

  const highRisk = /\b(delete|drop|remove|wipe|destroy|truncate)\b/.test(normalized);
  const ambiguousLanguage = /\b(maybe|either|or|unclear|ambiguous)\b/.test(normalized);
  const hasContradictoryActions =
    /\b(pause|stop)\b/.test(normalized) && /\b(enable|resume|start|unpause)\b/.test(normalized);
  const hasWriteIntent = /\b(apply|set|update|change|budget|pause|enable|resume|stop)\b/.test(
    normalized,
  );

  const ambiguous =
    ambiguousLanguage ||
    hasContradictoryActions ||
    (hasWriteIntent && (platforms.length === 0 || lowRiskOperations.length === 0));

  const riskLevel: "low" | "medium" | "high" = highRisk ? "high" : ambiguous ? "medium" : "low";

  return {
    riskLevel,
    operationCount: lowRiskOperations.length,
    budgetDelta,
    platforms,
    ambiguous,
  };
}

function resolvePolicyLimits(): {
  maxOperationsPerApply: number;
  maxOperationsPerDay: number;
  maxBudgetDelta: number;
} {
  return {
    maxOperationsPerApply: parsePositiveInt(process.env.PYREEL_MAX_OPERATIONS_PER_APPLY, 5),
    maxOperationsPerDay: parsePositiveInt(process.env.PYREEL_MAX_OPERATIONS_PER_DAY, 30),
    maxBudgetDelta: parsePositiveNumber(process.env.PYREEL_MAX_BUDGET_DELTA, 500),
  };
}

async function listChangeSets(workspaceDir: string): Promise<ChangeSetRecord[]> {
  try {
    const dir = changesetRoot(workspaceDir);
    const entries = await fs.readdir(dir);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const raw = await fs.readFile(path.join(dir, entry), "utf8");
          return JSON.parse(raw) as ChangeSetRecord;
        }),
    );
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function resolveAppliedOperationCountForUtcDay(
  workspaceDir: string,
  now: Date,
): Promise<number> {
  const dayKey = now.toISOString().slice(0, 10);
  const records = await listChangeSets(workspaceDir);
  return records
    .filter((record) => record.status === "applied" && record.appliedAt?.startsWith(dayKey))
    .reduce((sum, record) => sum + Math.max(0, record.analysis?.operationCount ?? 0), 0);
}

export function resolveConfirmationExpiry(now: Date, ttlSeconds: number): string {
  return new Date(now.getTime() + ttlSeconds * 1_000).toISOString();
}

export async function loadChangeSet(
  workspaceDir: string,
  changesetId: string,
): Promise<ChangeSetRecord | null> {
  try {
    const raw = await fs.readFile(changesetPath(workspaceDir, changesetId), "utf8");
    return JSON.parse(raw) as ChangeSetRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function saveChangeSet(workspaceDir: string, record: ChangeSetRecord): Promise<void> {
  await fs.mkdir(changesetRoot(workspaceDir), { recursive: true });
  await fs.writeFile(
    changesetPath(workspaceDir, record.id),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

async function appendAuditEvent(workspaceDir: string, event: ChangeSetAuditEvent): Promise<void> {
  const auditLogPath = auditPath(workspaceDir);
  await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
  await fs.appendFile(auditLogPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function transitionStatus(params: {
  workspaceDir: string;
  record: ChangeSetRecord;
  nextStatus: ChangeSetStatus;
  eventKind: ChangeSetAuditEvent["kind"];
  metadata?: Record<string, string | number | boolean | null>;
}): Promise<ChangeSetRecord> {
  const now = nowIso();
  const next: ChangeSetRecord = {
    ...params.record,
    status: params.nextStatus,
    updatedAt: now,
    appliedAt: params.nextStatus === "applied" ? now : params.record.appliedAt,
  };
  await saveChangeSet(params.workspaceDir, next);
  await appendAuditEvent(params.workspaceDir, {
    id: createId("evt"),
    changesetId: next.id,
    at: now,
    kind: params.eventKind,
    metadata: params.metadata,
  });
  return next;
}

export async function createDryRunChangeSet(params: {
  workspaceDir: string;
  request: string;
  confirmationTtlSeconds: number;
}): Promise<ChangeSetRecord> {
  const now = new Date();
  const id = createId("cs");
  const code = createConfirmationCode();
  const createdAt = now.toISOString();
  const record: ChangeSetRecord = {
    id,
    status: "awaiting_confirmation",
    createdAt,
    updatedAt: createdAt,
    dryRunRequest: params.request,
    analysis: analyzeDryRunRequest(params.request),
    confirmation: {
      code,
      issuedAt: createdAt,
      expiresAt: resolveConfirmationExpiry(now, params.confirmationTtlSeconds),
    },
  };

  await saveChangeSet(params.workspaceDir, record);
  await appendAuditEvent(params.workspaceDir, {
    id: createId("evt"),
    changesetId: id,
    at: createdAt,
    kind: "changeset_created",
    metadata: { status: "awaiting_confirmation", risk: record.analysis.riskLevel },
  });
  await appendAuditEvent(params.workspaceDir, {
    id: createId("evt"),
    changesetId: id,
    at: createdAt,
    kind: "confirmation_issued",
    metadata: { expiresAt: record.confirmation.expiresAt },
  });
  return record;
}

export async function confirmAndApplyChangeSet(params: {
  workspaceDir: string;
  changesetId: string;
  confirmationCode: string;
  autoApply?: boolean;
  platformAdapters?: Partial<Record<PyreelPlatform, PyreelPlatformWriteAdapter>>;
}): Promise<
  { ok: true; record: ChangeSetRecord } | { ok: false; reason: string; record?: ChangeSetRecord }
> {
  const record = await loadChangeSet(params.workspaceDir, params.changesetId);
  if (!record) {
    return { ok: false, reason: "not_found" };
  }

  if (record.status === "applied") {
    return { ok: false, reason: "already_applied", record };
  }

  if (record.status !== "awaiting_confirmation" || !record.confirmation) {
    return { ok: false, reason: "not_confirmable", record };
  }

  if (!writeGateEnabled()) {
    return { ok: false, reason: "writes_disabled", record };
  }

  const analysis = record.analysis ?? analyzeDryRunRequest(record.dryRunRequest);
  for (const platform of analysis.platforms) {
    if (!platformWriteGateEnabled(platform)) {
      return { ok: false, reason: `${platform}_writes_disabled`, record };
    }
  }

  if (new Date(record.confirmation.expiresAt).getTime() < Date.now()) {
    const rejected = await transitionStatus({
      workspaceDir: params.workspaceDir,
      record,
      nextStatus: "rejected",
      eventKind: "apply_rejected",
      metadata: { reason: "confirmation_expired" },
    });
    return { ok: false, reason: "confirmation_expired", record: rejected };
  }

  if (record.confirmation.code !== params.confirmationCode) {
    await appendAuditEvent(params.workspaceDir, {
      id: createId("evt"),
      changesetId: record.id,
      at: nowIso(),
      kind: "apply_rejected",
      metadata: { reason: "invalid_confirmation_code" },
    });
    return { ok: false, reason: "invalid_confirmation_code", record };
  }

  if (params.autoApply) {
    if (analysis.riskLevel !== "low") {
      return {
        ok: false,
        reason: "auto_apply_risk_denied_medium_or_high",
        record,
      };
    }

    if (analysis.ambiguous) {
      return {
        ok: false,
        reason: "ambiguous_operations_draft_only",
        record,
      };
    }

    const limits = resolvePolicyLimits();
    if (analysis.operationCount > limits.maxOperationsPerApply) {
      return {
        ok: false,
        reason: `max_operations_per_apply_exceeded:${limits.maxOperationsPerApply}`,
        record,
      };
    }

    const todayCount = await resolveAppliedOperationCountForUtcDay(params.workspaceDir, new Date());
    if (todayCount + analysis.operationCount > limits.maxOperationsPerDay) {
      return {
        ok: false,
        reason: `max_operations_per_day_exceeded:${limits.maxOperationsPerDay}`,
        record,
      };
    }

    if (analysis.budgetDelta > limits.maxBudgetDelta) {
      return {
        ok: false,
        reason: `max_budget_delta_exceeded:${limits.maxBudgetDelta}`,
        record,
      };
    }

    const operations = resolveLowRiskOperations(record.dryRunRequest, analysis.platforms);
    for (const platform of analysis.platforms) {
      const adapter = params.platformAdapters?.[platform];
      if (!adapter) {
        return {
          ok: false,
          reason: `platform_adapter_missing:${platform}`,
          record,
        };
      }
      const scopedOperations = operations.filter((operation) => operation.platform === platform);
      if (
        scopedOperations.some(
          (operation) => !["pause", "enable", "budget"].includes(operation.kind),
        )
      ) {
        return {
          ok: false,
          reason: "ambiguous_operations_draft_only",
          record,
        };
      }
      await adapter.applyLowRiskUpdates(scopedOperations);
    }
  }

  const applied = await transitionStatus({
    workspaceDir: params.workspaceDir,
    record: {
      ...record,
      analysis,
    },
    nextStatus: "applied",
    eventKind: "apply_confirmed",
  });

  return { ok: true, record: applied };
}
