import type { OpenClawConfig } from "../../config/config.js";
import {
  createPyreelAdsConnectors,
  type PyreelAdsConnector,
} from "../../pyreel/connectors/index.js";
import { buildRankedDiagnosis } from "../../pyreel/diagnose.js";
import {
  buildBudgetAllocationSummary,
  buildCreativeLeaderboard,
  buildDailySnapshot,
  buildWeeklyRollup,
} from "../../pyreel/reporting.js";
import type { FinalizedMsgContext } from "../templating.js";
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";
import {
  handlePyreelRbacCommand,
  resolvePyreelAccess,
  roleSatisfiesMinimum,
  type PyreelRbacCommand,
  type PyreelRole,
} from "./pyreel-rbac.js";
import {
  executePyreelWorkflow,
  type PyreelWorkflowAction,
  type RestrictedPyreelModelRunner,
} from "./pyreel-workflow.js";
import {
  confirmAndApplyChangeSet,
  createDryRunChangeSet,
} from "./pyreel/workspace/changesets/store.js";
import {
  autoApplyGuardEnabled,
  evaluateProactiveGuard,
  isLowRiskAutoApplyRequest,
  markProactivePosted,
  resolveProactiveReportDue,
  type ProactiveReportKind,
} from "./pyreel/workspace/proactive/state.js";

const PYREEL_HELP_TEXT =
  "Pyreel mode: use /pyreel help|brief|plan|research|scripts|report|next|apply, /pyreel proactive on|off|status|schedule|allow|disallow|quiet-hours, /pyreel whoami, or /pyreel rbac status|list|grant|revoke.";

type PyreelCommand =
  | "help"
  | "status"
  | "whoami"
  | "rbac"
  | PyreelRbacCommand
  | "apply"
  | "proactive"
  | PyreelWorkflowAction;

type PyreelRouterPassthroughDecision = {
  path: "passthrough";
  matchedCommand: null;
  deniedReason: null;
  reason: "pyreel_mode_disabled";
};

type PyreelRouterBlockDecision = {
  path: "block";
  matchedCommand: PyreelCommand | null;
  deniedReason:
    | "non_pyreel_input"
    | "unknown_command"
    | "feature_disabled"
    | "write_disabled"
    | "rbac_forbidden"
    | "proactive_disabled"
    | null;
  reason: "pyreel_mode_enforced";
  replyText: string;
};

export type PyreelRouterDecision = PyreelRouterPassthroughDecision | PyreelRouterBlockDecision;

const resolveInboundText = (ctx: FinalizedMsgContext): string => {
  const inboundBody = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  return inboundBody.trim();
};

function resolveSurface(ctx: FinalizedMsgContext): string {
  return (ctx.Surface ?? ctx.Provider ?? "unknown").trim().toLowerCase();
}

function pyreelWriteEnabled(cfg: OpenClawConfig, ctx: FinalizedMsgContext): boolean {
  const writes = cfg.pyreel?.writes;
  if (writes?.enabled === false) {
    return false;
  }

  const platformFlags = writes?.platforms;
  if (!platformFlags) {
    return true;
  }

  const platformFlag = platformFlags[resolveSurface(ctx)];
  return platformFlag;
}

function resolveConfirmationTtlSeconds(cfg: OpenClawConfig): number {
  const raw = cfg.pyreel?.writes?.confirmationTtlSeconds;
  if (!raw || raw <= 0) {
    return 900;
  }
  return Math.floor(raw);
}

function formatDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftUtcDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function pctText(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function resolveConnectorRuntimeConfig(
  prefix: "META" | "TIKTOK" | "GOOGLE",
): { baseUrl: string; accessToken: string } | undefined {
  const baseUrl = process.env[`PYREEL_${prefix}_BASE_URL`]?.trim();
  const accessToken = process.env[`PYREEL_${prefix}_ACCESS_TOKEN`]?.trim();
  if (!baseUrl || !accessToken) {
    return undefined;
  }
  return { baseUrl, accessToken };
}

function resolveAdsConnectors(explicitConnectors?: PyreelAdsConnector[]): PyreelAdsConnector[] {
  if (explicitConnectors) {
    return explicitConnectors;
  }
  return createPyreelAdsConnectors({
    meta: resolveConnectorRuntimeConfig("META"),
    tiktok: resolveConnectorRuntimeConfig("TIKTOK"),
    google: resolveConnectorRuntimeConfig("GOOGLE"),
  });
}

function buildManualReportFallback(): string {
  return [
    "Pyreel report (manual fallback)",
    "",
    "Connectors are disabled or returned no data. Use this checklist:",
    "1) Daily snapshot: spend, clicks, conversions, CPA by platform.",
    "2) Weekly rollup: compare this week vs previous week and note deltas.",
    "3) Creative leaderboard: rank top 3 creatives by conversions and CPA.",
    "4) Budget allocation: list spend share vs conversion share per platform.",
  ].join("\n");
}

function buildManualNextFallback(): string {
  return [
    "Pyreel next (manual fallback)",
    "",
    "No connector insights available. Run this action plan:",
    "- Pause bottom 10-20% creatives by conversion efficiency.",
    "- Reallocate 10-15% budget to best CPA platform.",
    "- Ship 2 new hooks based on top performer.",
    "- Validate with 72-hour checkpoint on conversions and CPA.",
  ].join("\n");
}

async function buildConnectorDrivenPyreelReply(params: {
  action: "report" | "next";
  connectors?: PyreelAdsConnector[];
  now?: Date;
}): Promise<string | null> {
  const connectors = resolveAdsConnectors(params.connectors).filter((connector) =>
    connector.isEnabled(),
  );
  if (connectors.length === 0) {
    return null;
  }

  const now = params.now ?? new Date();
  const dailyStart = formatDateUtc(now);
  const weekStart = formatDateUtc(shiftUtcDays(now, -6));
  const previousWeekStart = formatDateUtc(shiftUtcDays(now, -13));
  const previousWeekEnd = formatDateUtc(shiftUtcDays(now, -7));

  const metricsByConnector = await Promise.all(
    connectors.map(async (connector) => ({
      metricsDaily: await connector.readMetricsSummary({
        startDate: dailyStart,
        endDate: dailyStart,
      }),
      metricsWeekly: await connector.readMetricsSummary({
        startDate: weekStart,
        endDate: dailyStart,
      }),
      metricsPreviousWeek: await connector.readMetricsSummary({
        startDate: previousWeekStart,
        endDate: previousWeekEnd,
      }),
      ads: await connector.readAds(),
    })),
  );

  const dailyMetrics = metricsByConnector.flatMap((entry) => entry.metricsDaily);
  const weeklyMetrics = metricsByConnector.flatMap((entry) => entry.metricsWeekly);
  const previousWeekMetrics = metricsByConnector.flatMap((entry) => entry.metricsPreviousWeek);
  const ads = metricsByConnector.flatMap((entry) => entry.ads);
  if (weeklyMetrics.length === 0) {
    return null;
  }

  const dailySnapshot = buildDailySnapshot({ date: dailyStart, metrics: dailyMetrics });
  const weeklyRollup = buildWeeklyRollup({
    currentWeekMetrics: weeklyMetrics,
    previousWeekMetrics,
  });
  const leaderboard = buildCreativeLeaderboard({ ads, metrics: weeklyMetrics, limit: 3 });
  const budgetAllocation = buildBudgetAllocationSummary({ metrics: weeklyMetrics });
  const diagnosis = buildRankedDiagnosis({
    dailySnapshot,
    weeklyRollup,
    leaderboard,
    budgetAllocation,
  });

  if (params.action === "report") {
    return [
      "Pyreel report",
      "",
      `Daily snapshot (${dailySnapshot.date}): spend ${dailySnapshot.totals.spend.toFixed(2)}, clicks ${dailySnapshot.totals.clicks.toFixed(0)}, conversions ${dailySnapshot.totals.conversions.toFixed(1)}, CPA ${dailySnapshot.totals.cpa.toFixed(2)}.`,
      `Weekly rollup: spend ${weeklyRollup.currentWeek.spend.toFixed(2)} (${pctText(weeklyRollup.deltas.spendPct)}), conversions ${weeklyRollup.currentWeek.conversions.toFixed(1)} (${pctText(weeklyRollup.deltas.conversionsPct)}), CPA ${weeklyRollup.currentWeek.cpa.toFixed(2)} (${pctText(weeklyRollup.deltas.cpaPct)}).`,
      "Creative leaderboard:",
      ...leaderboard.map(
        (item) =>
          `- #${item.rank} ${item.platform}/${item.name}: conv ${item.conversions.toFixed(1)}, CPA ${item.cpa.toFixed(2)}, CTR ${pctText(item.ctr)}.`,
      ),
      "Budget allocation:",
      ...budgetAllocation.map(
        (item) =>
          `- ${item.platform}: spend share ${pctText(item.spendSharePct)}, conversion share ${pctText(item.conversionSharePct)}.`,
      ),
    ].join("\n");
  }

  return [
    "Pyreel next",
    "",
    "Top ranked diagnoses:",
    ...diagnosis
      .slice(0, 3)
      .map(
        (item) =>
          `${item.rank}. ${item.title}\n   Evidence: ${item.evidence}\n   Actions: ${item.actions.join(" ")}\n   Confidence: ${pctText(item.confidence)}\n   Validation: ${item.validation}`,
      ),
  ].join("\n");
}

const WORKFLOW_ACTIONS = new Set<PyreelWorkflowAction>([
  "brief",
  "plan",
  "research",
  "scripts",
  "report",
  "next",
]);

const COMMAND_MIN_ROLE: Record<string, PyreelRole> = {
  help: "viewer",
  status: "viewer",
  whoami: "viewer",
  apply: "approver",
  brief: "operator",
  plan: "operator",
  research: "operator",
  scripts: "operator",
  report: "viewer",
  next: "operator",
  rbac_status: "viewer",
  rbac_list: "viewer",
  rbac_grant: "admin",
  rbac_revoke: "admin",
  rbac: "viewer",
  proactive: "admin",
};

function requireScopedIdentityForAction(action: string): boolean {
  return (
    action === "apply" ||
    action === "rbac_grant" ||
    action === "rbac_revoke" ||
    action === "proactive"
  );
}

async function enforceRole(params: {
  action: string;
  ctx: FinalizedMsgContext;
  workspaceDir?: string;
  matchedCommand: PyreelCommand;
}): Promise<PyreelRouterDecision | null> {
  const minRole = COMMAND_MIN_ROLE[params.action] ?? "viewer";
  const access = await resolvePyreelAccess({
    workspaceDir: params.workspaceDir,
    ctx: params.ctx,
    requireScopedIdentityForGrant: requireScopedIdentityForAction(params.action),
  });
  if (!access.denied && roleSatisfiesMinimum(access.role, minRole)) {
    return null;
  }

  return {
    path: "block",
    matchedCommand: params.matchedCommand,
    deniedReason: "rbac_forbidden",
    reason: "pyreel_mode_enforced",
    replyText: `Pyreel RBAC denied: ${params.action} requires ${minRole}.`,
  };
}

function resolveProactiveCommand(args: string): {
  subcommand: "on" | "off" | "status" | "schedule" | "allow" | "disallow" | "quiet-hours";
  rest: string;
} | null {
  const tokens = args.split(/\s+/).filter((token) => token.length > 0);
  const subcommand = (tokens[0] ?? "status").toLowerCase();
  const rest = tokens.slice(1).join(" ");
  if (
    subcommand === "on" ||
    subcommand === "off" ||
    subcommand === "status" ||
    subcommand === "schedule" ||
    subcommand === "allow" ||
    subcommand === "disallow" ||
    subcommand === "quiet-hours"
  ) {
    return { subcommand, rest };
  }
  return null;
}

function resolveProactiveKind(raw: string): ProactiveReportKind | null {
  const token = raw.trim().toLowerCase();
  if (token === "daily" || token === "weekly") {
    return token;
  }
  return null;
}

function resolveRbacCommandForAuth(args: string): PyreelRbacCommand {
  const tokens = args.split(/\s+/).filter((token) => token.length > 0);
  const subcommand = (tokens[0] ?? "status").toLowerCase();
  if (subcommand === "list") {
    return "rbac_list";
  }
  if (subcommand === "grant") {
    return "rbac_grant";
  }
  if (subcommand === "revoke") {
    return "rbac_revoke";
  }
  return "rbac_status";
}

export async function routePyreelMessage(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  restrictedModelRunner?: RestrictedPyreelModelRunner;
  pyreelAdsConnectors?: PyreelAdsConnector[];
}): Promise<PyreelRouterDecision> {
  const { ctx, cfg } = params;
  if (cfg.pyreel?.mode !== true) {
    return {
      path: "passthrough",
      matchedCommand: null,
      deniedReason: null,
      reason: "pyreel_mode_disabled",
    };
  }

  const inboundText = resolveInboundText(ctx);
  const parsed = parseSlashCommandOrNull(inboundText, "/pyreel", {
    invalidMessage: PYREEL_HELP_TEXT,
    defaultAction: "help",
  });

  if (!parsed) {
    return {
      path: "block",
      matchedCommand: null,
      deniedReason: "non_pyreel_input",
      reason: "pyreel_mode_enforced",
      replyText: PYREEL_HELP_TEXT,
    };
  }

  if (!parsed.ok) {
    return {
      path: "block",
      matchedCommand: null,
      deniedReason: "unknown_command",
      reason: "pyreel_mode_enforced",
      replyText: PYREEL_HELP_TEXT,
    };
  }

  const action = parsed.action;
  if (action === "help") {
    const denied = await enforceRole({
      action,
      ctx,
      workspaceDir: params.workspaceDir,
      matchedCommand: "help",
    });
    if (denied) {
      return denied;
    }
    return {
      path: "block",
      matchedCommand: "help",
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: PYREEL_HELP_TEXT,
    };
  }

  if (action === "whoami" || action === "rbac") {
    const authCommand = action === "whoami" ? "whoami" : resolveRbacCommandForAuth(parsed.args);
    const deny = await enforceRole({
      action: authCommand,
      ctx,
      workspaceDir: params.workspaceDir,
      matchedCommand: authCommand,
    });
    if (deny) {
      return deny;
    }

    const rbacResult = await handlePyreelRbacCommand({
      action,
      args: parsed.args,
      workspaceDir: params.workspaceDir,
      ctx,
    });

    if (!rbacResult.handled) {
      return {
        path: "block",
        matchedCommand: null,
        deniedReason: "unknown_command",
        reason: "pyreel_mode_enforced",
        replyText: PYREEL_HELP_TEXT,
      };
    }

    return {
      path: "block",
      matchedCommand:
        rbacResult.command === undefined ? action : (rbacResult.command as PyreelCommand),
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: rbacResult.replyText ?? "",
    };
  }

  if (action === "ingest" || action === "remix" || action === "export") {
    return {
      path: "block",
      matchedCommand: null,
      deniedReason: "unknown_command",
      reason: "pyreel_mode_enforced",
      replyText: PYREEL_HELP_TEXT,
    };
  }

  if (action === "proactive") {
    const denied = await enforceRole({
      action,
      ctx,
      workspaceDir: params.workspaceDir,
      matchedCommand: "proactive",
    });
    if (denied) {
      return denied;
    }

    const workspaceDir = params.workspaceDir?.trim();
    if (!workspaceDir) {
      return {
        path: "block",
        matchedCommand: "proactive",
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: "Pyreel proactive requires a workspace directory.",
      };
    }

    const proactiveCommand = resolveProactiveCommand(parsed.args);
    if (!proactiveCommand) {
      return {
        path: "block",
        matchedCommand: "proactive",
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: "Usage: /pyreel proactive on|off|status|schedule|allow|disallow|quiet-hours",
      };
    }

    if (proactiveCommand.subcommand === "status") {
      return {
        path: "block",
        matchedCommand: "proactive",
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: "Pyreel proactive status command received.",
      };
    }

    if (
      proactiveCommand.subcommand === "on" ||
      proactiveCommand.subcommand === "off" ||
      proactiveCommand.subcommand === "allow" ||
      proactiveCommand.subcommand === "disallow" ||
      proactiveCommand.subcommand === "quiet-hours"
    ) {
      return {
        path: "block",
        matchedCommand: "proactive",
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: `Pyreel proactive ${proactiveCommand.subcommand} command received.`,
      };
    }

    const kind = resolveProactiveKind(proactiveCommand.rest);
    if (!kind) {
      return {
        path: "block",
        matchedCommand: "proactive",
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: "Usage: /pyreel proactive schedule <daily|weekly>",
      };
    }

    const guard = await evaluateProactiveGuard({
      cfg,
      ctx,
      workspaceDir,
      kind,
    });

    if (!guard.allowed) {
      const nextDue = resolveProactiveReportDue({
        kind,
        nowMs: Date.now(),
        timezone: cfg.pyreel?.proactive?.timezone,
      });
      return {
        path: "block",
        matchedCommand: "proactive",
        deniedReason: guard.reason === "proactive_disabled" ? "proactive_disabled" : null,
        reason: "pyreel_mode_enforced",
        replyText: `Pyreel proactive ${kind} skipped: ${guard.reason}.${nextDue ? ` Next due at ${new Date(nextDue).toISOString()}.` : ""}`,
      };
    }

    const artifact = await executePyreelWorkflow({
      action: "report",
      request: `${kind} proactive report`,
      workspaceDir,
      runner: params.restrictedModelRunner,
    });
    await markProactivePosted({ workspaceDir, state: guard.state, kind });

    return {
      path: "block",
      matchedCommand: "proactive",
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: `Pyreel proactive ${kind} posted via ${artifact.relativeArtifactPath}.`,
    };
  }

  if (action === "apply") {
    const denied = await enforceRole({
      action,
      ctx,
      workspaceDir: params.workspaceDir,
      matchedCommand: "apply",
    });
    if (denied) {
      return denied;
    }

    const workspaceDir = params.workspaceDir?.trim();
    if (!workspaceDir) {
      return {
        path: "block",
        matchedCommand: "apply",
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: "Pyreel apply requires a workspace directory.",
      };
    }

    if (!pyreelWriteEnabled(cfg, ctx)) {
      return {
        path: "block",
        matchedCommand: "apply",
        deniedReason: "write_disabled",
        reason: "pyreel_mode_enforced",
        replyText: "Pyreel apply is write-disabled for this surface.",
      };
    }

    const tokens = parsed.args.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.includes("--auto-apply")) {
      if (!autoApplyGuardEnabled(cfg, ctx)) {
        return {
          path: "block",
          matchedCommand: "apply",
          deniedReason: "write_disabled",
          reason: "pyreel_mode_enforced",
          replyText: "Pyreel auto-apply is disabled for this surface.",
        };
      }

      const autoApplyRequest = tokens
        .filter((token) => token !== "--auto-apply")
        .join(" ")
        .trim();
      if (!isLowRiskAutoApplyRequest(autoApplyRequest)) {
        return {
          path: "block",
          matchedCommand: "apply",
          deniedReason: null,
          reason: "pyreel_mode_enforced",
          replyText:
            "Pyreel auto-apply rejected: request is not low-risk. Use /pyreel apply --dry-run instead.",
        };
      }

      const created = await createDryRunChangeSet({
        workspaceDir,
        request: autoApplyRequest || "No request provided",
        confirmationTtlSeconds: resolveConfirmationTtlSeconds(cfg),
      });
      const applyResult = await confirmAndApplyChangeSet({
        workspaceDir,
        changesetId: created.id,
        confirmationCode: created.confirmation?.code ?? "",
      });

      if (!applyResult.ok) {
        return {
          path: "block",
          matchedCommand: "apply",
          deniedReason: null,
          reason: "pyreel_mode_enforced",
          replyText: `ChangeSet auto-apply failed: ${applyResult.reason}.`,
        };
      }

      return {
        path: "block",
        matchedCommand: "apply",
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: `ChangeSet ${applyResult.record.id} auto-applied successfully.`,
      };
    }
    if (tokens.includes("--dry-run")) {
      const dryRunRequest = tokens
        .filter((token) => token !== "--dry-run")
        .join(" ")
        .trim();
      const created = await createDryRunChangeSet({
        workspaceDir,
        request: dryRunRequest || "No request provided",
        confirmationTtlSeconds: resolveConfirmationTtlSeconds(cfg),
      });

      return {
        path: "block",
        matchedCommand: "apply",
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: `Dry run created for ChangeSet ${created.id}. Confirm with /pyreel apply ${created.id} ${created.confirmation?.code}. Code expires at ${created.confirmation?.expiresAt}.`,
      };
    }

    if (tokens.length < 2) {
      return {
        path: "block",
        matchedCommand: "apply",
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText:
          "Use /pyreel apply --dry-run <request> or /pyreel apply <changeset_id> <confirm_code>.",
      };
    }

    const [changesetId, confirmationCode] = tokens;
    const applyResult = await confirmAndApplyChangeSet({
      workspaceDir,
      changesetId,
      confirmationCode,
    });

    if (!applyResult.ok) {
      return {
        path: "block",
        matchedCommand: "apply",
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: `ChangeSet apply failed: ${applyResult.reason}.`,
      };
    }

    return {
      path: "block",
      matchedCommand: "apply",
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: `ChangeSet ${applyResult.record.id} applied successfully.`,
    };
  }

  if (WORKFLOW_ACTIONS.has(action as PyreelWorkflowAction)) {
    const workflowAction = action as PyreelWorkflowAction;
    const denied = await enforceRole({
      action,
      ctx,
      workspaceDir: params.workspaceDir,
      matchedCommand: workflowAction,
    });
    if (denied) {
      return denied;
    }

    if (workflowAction === "report" || workflowAction === "next") {
      const connectorReply = await buildConnectorDrivenPyreelReply({
        action: workflowAction,
        connectors: params.pyreelAdsConnectors,
      });
      return {
        path: "block",
        matchedCommand: workflowAction,
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText:
          connectorReply ??
          (workflowAction === "report" ? buildManualReportFallback() : buildManualNextFallback()),
      };
    }

    const workspaceDir = params.workspaceDir?.trim();
    if (!workspaceDir) {
      return {
        path: "block",
        matchedCommand: workflowAction,
        deniedReason: null,
        reason: "pyreel_mode_enforced",
        replyText: `Pyreel ${workflowAction} requires a workspace directory.`,
      };
    }

    if (!pyreelWriteEnabled(cfg, ctx)) {
      return {
        path: "block",
        matchedCommand: workflowAction,
        deniedReason: "write_disabled",
        reason: "pyreel_mode_enforced",
        replyText: `Pyreel ${workflowAction} is write-disabled for this surface.`,
      };
    }

    const artifact = await executePyreelWorkflow({
      action: workflowAction,
      request: parsed.args,
      workspaceDir,
      runner: params.restrictedModelRunner,
    });

    return {
      path: "block",
      matchedCommand: workflowAction,
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: artifact.summary,
    };
  }

  return {
    path: "block",
    matchedCommand: null,
    deniedReason: "unknown_command",
    reason: "pyreel_mode_enforced",
    replyText: PYREEL_HELP_TEXT,
  };
}
