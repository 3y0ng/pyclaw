import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePyreelWorkspaceFilePath,
  resolvePyreelWorkspacePath,
  resolvePyreelWorkspaceSubdirPath,
} from "../paths.js";
import type { ChangeSetAuditEvent, ChangeSetRecord, ChangeSetStatus } from "./model.js";

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
    metadata: { status: "awaiting_confirmation" },
  });
  await appendAuditEvent(params.workspaceDir, {
    id: createId("evt"),
    changesetId: id,
    at: createdAt,
    kind: "confirmation_issued",
    metadata: { expiresAt: record.confirmation?.expiresAt ?? "" },
  });
  return record;
}

export async function confirmAndApplyChangeSet(params: {
  workspaceDir: string;
  changesetId: string;
  confirmationCode: string;
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

  const applied = await transitionStatus({
    workspaceDir: params.workspaceDir,
    record,
    nextStatus: "applied",
    eventKind: "apply_confirmed",
  });

  return { ok: true, record: applied };
}
