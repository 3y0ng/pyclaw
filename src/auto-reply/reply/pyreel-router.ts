import type { OpenClawConfig } from "../../config/config.js";
import type { FinalizedMsgContext } from "../templating.js";
import { parseSlashCommandOrNull } from "./commands-slash-parse.js";
import {
  executePyreelWorkflow,
  type PyreelWorkflowAction,
  type RestrictedPyreelModelRunner,
} from "./pyreel-workflow.js";
import {
  confirmAndApplyChangeSet,
  createDryRunChangeSet,
} from "./pyreel/workspace/changesets/store.js";

const PYREEL_HELP_TEXT =
  "Pyreel mode: use /pyreel help, /pyreel status, /pyreel ingest, /pyreel remix, /pyreel export, /pyreel apply, /pyreel brief, /pyreel plan, /pyreel research, /pyreel scripts, /pyreel report, or /pyreel next.";

type PyreelCommand =
  | "help"
  | "status"
  | "ingest"
  | "remix"
  | "export"
  | "apply"
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
    | null;
  reason: "pyreel_mode_enforced";
  replyText: string;
};

export type PyreelRouterDecision = PyreelRouterPassthroughDecision | PyreelRouterBlockDecision;

const resolveInboundText = (ctx: FinalizedMsgContext): string => {
  const inboundBody = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  return inboundBody.trim();
};

const featureEnabled = (cfg: OpenClawConfig, feature: "ingest" | "remix" | "export"): boolean =>
  cfg.pyreel?.features?.[feature] !== false;

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

const WORKFLOW_ACTIONS = new Set<PyreelWorkflowAction>([
  "brief",
  "plan",
  "research",
  "scripts",
  "report",
  "next",
]);

export async function routePyreelMessage(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  restrictedModelRunner?: RestrictedPyreelModelRunner;
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
    return {
      path: "block",
      matchedCommand: "help",
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: PYREEL_HELP_TEXT,
    };
  }

  if (action === "status") {
    const ingestEnabled = featureEnabled(cfg, "ingest") ? "on" : "off";
    const remixEnabled = featureEnabled(cfg, "remix") ? "on" : "off";
    const exportEnabled = featureEnabled(cfg, "export") ? "on" : "off";
    return {
      path: "block",
      matchedCommand: "status",
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: `Pyreel status: ingest=${ingestEnabled}, remix=${remixEnabled}, export=${exportEnabled}.`,
    };
  }

  if (action === "ingest" || action === "remix" || action === "export") {
    if (!featureEnabled(cfg, action)) {
      return {
        path: "block",
        matchedCommand: action,
        deniedReason: "feature_disabled",
        reason: "pyreel_mode_enforced",
        replyText: `Pyreel ${action} is disabled in config.`,
      };
    }
    return {
      path: "block",
      matchedCommand: action,
      deniedReason: null,
      reason: "pyreel_mode_enforced",
      replyText: `Pyreel ${action} command received.`,
    };
  }

  if (action === "apply") {
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
