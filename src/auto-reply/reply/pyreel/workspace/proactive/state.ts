import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../../../../../config/config.js";
import { computeNextRunAtMs } from "../../../../../cron/schedule.js";
import type { FinalizedMsgContext } from "../../../../templating.js";
import { resolvePyreelWorkspaceFilePath } from "../paths.js";

export type ProactiveReportKind = "daily" | "weekly";

export type PyreelProactiveState = {
  version: 1;
  allowlist: {
    identities: string[];
    surfaces: string[];
  };
  quietHours?: {
    startHour: number;
    endHour: number;
  };
  rateLimits?: {
    perHour: number;
    perDay: number;
  };
  counters: {
    hourWindowKey: string;
    dayWindowKey: string;
    hourCount: number;
    dayCount: number;
  };
  postedReports: Record<ProactiveReportKind, string>;
};

export type ProactiveGuardResult =
  | { allowed: true; state: PyreelProactiveState }
  | { allowed: false; reason: string; state: PyreelProactiveState };

function defaultState(): PyreelProactiveState {
  return {
    version: 1,
    allowlist: {
      identities: [],
      surfaces: [],
    },
    counters: {
      hourWindowKey: "",
      dayWindowKey: "",
      hourCount: 0,
      dayCount: 0,
    },
    postedReports: {
      daily: "",
      weekly: "",
    },
  };
}

function proactiveStatePath(workspaceDir: string): string {
  return resolvePyreelWorkspaceFilePath(workspaceDir, "state.json");
}

function normalizeIdentity(identity: string): string {
  return identity.trim().toLowerCase();
}

function resolveIdentityCandidates(ctx: FinalizedMsgContext): string[] {
  const surface = (ctx.Surface ?? ctx.Provider ?? "unknown").trim().toLowerCase();
  const values = [ctx.SenderId, ctx.SenderUsername, ctx.SenderTag, ctx.From]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const keys = new Set<string>();
  for (const value of values) {
    keys.add(normalizeIdentity(value));
    keys.add(normalizeIdentity(`${surface}:${value}`));
  }
  return [...keys];
}

function resolveWindowKeys(now: Date): { hour: string; day: string } {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  return {
    hour: `${year}-${month}-${day}T${hour}`,
    day: `${year}-${month}-${day}`,
  };
}

function resolveReportIdempotencyKey(kind: ProactiveReportKind, now: Date): string {
  const year = now.getUTCFullYear();
  if (kind === "daily") {
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    return `${kind}:${year}-${month}-${day}`;
  }

  const firstDay = new Date(Date.UTC(year, 0, 1));
  const dayOffset = Math.floor((now.getTime() - firstDay.getTime()) / 86_400_000);
  const week = String(Math.floor(dayOffset / 7) + 1).padStart(2, "0");
  return `${kind}:${year}-W${week}`;
}

function inQuietHours(now: Date, quietHours?: { startHour: number; endHour: number }): boolean {
  if (!quietHours) {
    return false;
  }
  const start = Math.min(23, Math.max(0, Math.floor(quietHours.startHour)));
  const end = Math.min(23, Math.max(0, Math.floor(quietHours.endHour)));
  const hour = now.getHours();
  if (start === end) {
    return false;
  }
  if (start < end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}

export function proactiveFeatureEnabled(cfg: OpenClawConfig): boolean {
  return (
    cfg.pyreel?.mode === true &&
    cfg.pyreel?.features?.proactive === true &&
    cfg.pyreel?.proactive?.enabled === true
  );
}

export async function loadProactiveState(workspaceDir: string): Promise<PyreelProactiveState> {
  try {
    const raw = await fs.readFile(proactiveStatePath(workspaceDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<PyreelProactiveState>;
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      allowlist: {
        identities: Array.isArray(parsed.allowlist?.identities)
          ? parsed.allowlist.identities.map((value) => normalizeIdentity(String(value)))
          : base.allowlist.identities,
        surfaces: Array.isArray(parsed.allowlist?.surfaces)
          ? parsed.allowlist.surfaces.map((value) => String(value).trim().toLowerCase())
          : base.allowlist.surfaces,
      },
      counters: {
        ...base.counters,
        ...parsed.counters,
      },
      postedReports: {
        ...base.postedReports,
        ...parsed.postedReports,
      },
    };
  } catch {
    return defaultState();
  }
}

export async function saveProactiveState(
  workspaceDir: string,
  state: PyreelProactiveState,
): Promise<void> {
  const statePath = proactiveStatePath(workspaceDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function evaluateProactiveGuard(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  workspaceDir: string;
  kind: ProactiveReportKind;
  now?: Date;
}): Promise<ProactiveGuardResult> {
  const now = params.now ?? new Date();
  const state = await loadProactiveState(params.workspaceDir);

  if (!proactiveFeatureEnabled(params.cfg)) {
    return { allowed: false, reason: "proactive_disabled", state };
  }

  const surface = (params.ctx.Surface ?? params.ctx.Provider ?? "unknown").trim().toLowerCase();
  if (state.allowlist.surfaces.length > 0 && !state.allowlist.surfaces.includes(surface)) {
    return { allowed: false, reason: "surface_not_allowlisted", state };
  }

  const identityCandidates = resolveIdentityCandidates(params.ctx);
  if (
    state.allowlist.identities.length > 0 &&
    !identityCandidates.some((value) => state.allowlist.identities.includes(value))
  ) {
    return { allowed: false, reason: "identity_not_allowlisted", state };
  }

  if (inQuietHours(now, state.quietHours)) {
    return { allowed: false, reason: "quiet_hours", state };
  }

  const idempotencyKey = resolveReportIdempotencyKey(params.kind, now);
  if (state.postedReports[params.kind] === idempotencyKey) {
    return { allowed: false, reason: "already_posted", state };
  }

  const windowKeys = resolveWindowKeys(now);
  const counters = {
    hourWindowKey:
      state.counters.hourWindowKey === windowKeys.hour
        ? state.counters.hourWindowKey
        : windowKeys.hour,
    dayWindowKey:
      state.counters.dayWindowKey === windowKeys.day ? state.counters.dayWindowKey : windowKeys.day,
    hourCount: state.counters.hourWindowKey === windowKeys.hour ? state.counters.hourCount : 0,
    dayCount: state.counters.dayWindowKey === windowKeys.day ? state.counters.dayCount : 0,
  };

  if (state.rateLimits?.perHour && counters.hourCount >= state.rateLimits.perHour) {
    return { allowed: false, reason: "rate_limit_hour", state: { ...state, counters } };
  }

  if (state.rateLimits?.perDay && counters.dayCount >= state.rateLimits.perDay) {
    return { allowed: false, reason: "rate_limit_day", state: { ...state, counters } };
  }

  return { allowed: true, state: { ...state, counters } };
}

export async function markProactivePosted(params: {
  workspaceDir: string;
  state: PyreelProactiveState;
  kind: ProactiveReportKind;
  now?: Date;
}): Promise<PyreelProactiveState> {
  const now = params.now ?? new Date();
  const idempotencyKey = resolveReportIdempotencyKey(params.kind, now);
  const next: PyreelProactiveState = {
    ...params.state,
    counters: {
      ...params.state.counters,
      hourCount: params.state.counters.hourCount + 1,
      dayCount: params.state.counters.dayCount + 1,
    },
    postedReports: {
      ...params.state.postedReports,
      [params.kind]: idempotencyKey,
    },
  };
  await saveProactiveState(params.workspaceDir, next);
  return next;
}

export function resolveProactiveReportDue(params: {
  kind: ProactiveReportKind;
  nowMs: number;
  timezone?: string;
}): number | undefined {
  const schedule =
    params.kind === "daily"
      ? { kind: "cron" as const, expr: "0 9 * * *", tz: params.timezone }
      : { kind: "cron" as const, expr: "0 9 * * 1", tz: params.timezone };
  return computeNextRunAtMs(schedule, params.nowMs);
}

export function autoApplyGuardEnabled(cfg: OpenClawConfig, ctx: FinalizedMsgContext): boolean {
  if (cfg.pyreel?.mode !== true || cfg.pyreel?.autoApply?.enabled !== true) {
    return false;
  }
  const platformFlags = cfg.pyreel.autoApply.platforms;
  if (!platformFlags) {
    return true;
  }
  const surface = (ctx.Surface ?? ctx.Provider ?? "unknown").trim().toLowerCase();
  return platformFlags[surface] === true;
}

export function isLowRiskAutoApplyRequest(request: string): boolean {
  const trimmed = request.trim();
  if (!trimmed) {
    return false;
  }
  return !/\b(delete|drop|remove|disable|wipe|destroy|truncate)\b/i.test(trimmed);
}
