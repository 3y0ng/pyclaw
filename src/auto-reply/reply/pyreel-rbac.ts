import fs from "node:fs/promises";
import path from "node:path";
import type { FinalizedMsgContext } from "../templating.js";

const ACL_PATH_PARTS = ["pyreel", "workspace", "acl.json"];

export type PyreelRole = "viewer" | "operator" | "approver" | "admin";

export type PyreelGrantEntry = {
  identity: string;
  role: PyreelRole;
};

export type PyreelDenyEntry = {
  identity: string;
  reason?: string;
};

export type PyreelAclFile = {
  version: 1;
  grants: PyreelGrantEntry[];
  denies?: PyreelDenyEntry[];
};

export type PyreelRbacCommand =
  | "whoami"
  | "rbac_status"
  | "rbac_list"
  | "rbac_grant"
  | "rbac_revoke";

const ROLE_ORDER: Record<PyreelRole, number> = {
  viewer: 1,
  operator: 2,
  approver: 3,
  admin: 4,
};

const normalizeIdentity = (identity: string): string => identity.trim().toLowerCase();

function canonicalSurface(ctx: FinalizedMsgContext): string {
  return (ctx.Surface ?? ctx.Provider ?? "unknown").trim().toLowerCase();
}

export function resolvePyreelIdentityKeys(ctx: FinalizedMsgContext): string[] {
  const surface = canonicalSurface(ctx);
  const baseCandidates = [
    ctx.SenderId,
    ctx.SenderUsername,
    ctx.SenderTag,
    ctx.SenderE164,
    ctx.From,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const keys = new Set<string>();
  for (const candidate of baseCandidates) {
    const trimmed = candidate.trim();
    keys.add(normalizeIdentity(`${surface}:${trimmed}`));
    keys.add(normalizeIdentity(trimmed));
  }

  keys.add(normalizeIdentity(`${surface}:${ctx.From ?? "unknown"}`));
  return [...keys];
}

function splitIdentityKeys(keys: string[]): { scoped: string[]; unscoped: string[] } {
  const scoped: string[] = [];
  const unscoped: string[] = [];
  for (const key of keys) {
    if (key.includes(":")) {
      scoped.push(key);
      continue;
    }
    unscoped.push(key);
  }
  return { scoped, unscoped };
}

function parseRole(rawRole: unknown): PyreelRole | null {
  if (
    rawRole === "viewer" ||
    rawRole === "operator" ||
    rawRole === "approver" ||
    rawRole === "admin"
  ) {
    return rawRole;
  }
  // Backward-compatibility with legacy ACLs.
  if (rawRole === "editor") {
    return "operator";
  }
  return null;
}

async function readAclFile(workspaceDir: string): Promise<PyreelAclFile> {
  const aclPath = path.join(workspaceDir, ...ACL_PATH_PARTS);
  try {
    const raw = await fs.readFile(aclPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PyreelAclFile>;
    return {
      version: 1,
      grants: Array.isArray(parsed.grants)
        ? parsed.grants
            .filter((entry): entry is PyreelGrantEntry => {
              return typeof entry?.identity === "string" && parseRole(entry.role) !== null;
            })
            .map((entry) => ({
              identity: normalizeIdentity(entry.identity),
              role: parseRole(entry.role) ?? "viewer",
            }))
        : [],
      denies: Array.isArray(parsed.denies)
        ? parsed.denies
            .filter((entry): entry is PyreelDenyEntry => typeof entry?.identity === "string")
            .map((entry) => ({
              identity: normalizeIdentity(entry.identity),
              reason: typeof entry.reason === "string" ? entry.reason : undefined,
            }))
        : undefined,
    };
  } catch {
    return { version: 1, grants: [] };
  }
}

async function writeAclFile(workspaceDir: string, acl: PyreelAclFile): Promise<void> {
  const aclPath = path.join(workspaceDir, ...ACL_PATH_PARTS);
  await fs.mkdir(path.dirname(aclPath), { recursive: true });
  await fs.writeFile(aclPath, `${JSON.stringify(acl, null, 2)}\n`, "utf8");
}

export async function resolvePyreelAccess(params: {
  workspaceDir?: string;
  ctx: FinalizedMsgContext;
  requireScopedIdentityForGrant?: boolean;
}): Promise<{
  role: PyreelRole;
  denied: boolean;
  denyIdentity: string | null;
  matchedGrant: PyreelGrantEntry | null;
  identityKeys: string[];
}> {
  const identityKeys = resolvePyreelIdentityKeys(params.ctx);
  const splitKeys = splitIdentityKeys(identityKeys);
  if (!params.workspaceDir) {
    return {
      role: params.ctx.CommandAuthorized ? "admin" : "operator",
      denied: false,
      denyIdentity: null,
      matchedGrant: null,
      identityKeys,
    };
  }

  const acl = await readAclFile(params.workspaceDir);
  const deniedMatch =
    acl.denies?.find((entry) => splitKeys.scoped.includes(entry.identity)) ??
    acl.denies?.find((entry) => splitKeys.unscoped.includes(entry.identity));
  if (deniedMatch) {
    return {
      role: "viewer",
      denied: true,
      denyIdentity: deniedMatch.identity,
      matchedGrant: null,
      identityKeys,
    };
  }

  let matchedGrant: PyreelGrantEntry | null = null;
  const grantCandidates = params.requireScopedIdentityForGrant
    ? splitKeys.scoped
    : [...splitKeys.scoped, ...splitKeys.unscoped];
  for (const grant of acl.grants) {
    if (!grantCandidates.includes(grant.identity)) {
      continue;
    }
    if (!matchedGrant || ROLE_ORDER[grant.role] > ROLE_ORDER[matchedGrant.role]) {
      matchedGrant = grant;
    }
  }

  return {
    role: matchedGrant?.role ?? (params.ctx.CommandAuthorized ? "admin" : "operator"),
    denied: false,
    denyIdentity: null,
    matchedGrant,
    identityKeys,
  };
}

export function roleSatisfiesMinimum(role: PyreelRole, minimum: PyreelRole): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[minimum];
}

export async function handlePyreelRbacCommand(params: {
  workspaceDir?: string;
  action: string;
  args: string;
  ctx: FinalizedMsgContext;
}): Promise<{ handled: boolean; replyText?: string; command?: PyreelRbacCommand }> {
  const { action, args, workspaceDir, ctx } = params;
  if (action === "whoami") {
    const access = await resolvePyreelAccess({ workspaceDir, ctx });
    return {
      handled: true,
      command: "whoami",
      replyText: `Pyreel identity: role=${access.role}, denied=${access.denied ? "yes" : "no"}, keys=[${access.identityKeys.join(", ")}].`,
    };
  }

  if (action !== "rbac") {
    return { handled: false };
  }

  const tokens = args.split(/\s+/).filter((token) => token.length > 0);
  const subcommand = (tokens[0] ?? "status").toLowerCase();

  if (subcommand === "status") {
    const access = await resolvePyreelAccess({ workspaceDir, ctx });
    return {
      handled: true,
      command: "rbac_status",
      replyText: `Pyreel RBAC status: role=${access.role}, denied=${access.denied ? "yes" : "no"}${access.denyIdentity ? ` (${access.denyIdentity})` : ""}.`,
    };
  }

  if (!workspaceDir) {
    return {
      handled: true,
      command: "rbac_status",
      replyText: "Pyreel RBAC requires a workspace directory.",
    };
  }

  const acl = await readAclFile(workspaceDir);

  if (subcommand === "list") {
    const grants = acl.grants.map((entry) => `${entry.identity}=${entry.role}`);
    const denies = (acl.denies ?? []).map((entry) => entry.identity);
    return {
      handled: true,
      command: "rbac_list",
      replyText: `Pyreel RBAC list: grants=[${grants.join(", ")}], denies=[${denies.join(", ")}].`,
    };
  }

  if (subcommand === "grant") {
    const identity = normalizeIdentity(tokens[1] ?? "");
    const role = (tokens[2] ?? "").toLowerCase() as PyreelRole;
    if (
      !identity ||
      !(role === "viewer" || role === "operator" || role === "approver" || role === "admin")
    ) {
      return {
        handled: true,
        command: "rbac_grant",
        replyText: "Usage: /pyreel rbac grant <identity> <viewer|operator|approver|admin>",
      };
    }

    const nextGrants = acl.grants.filter((entry) => entry.identity !== identity);
    nextGrants.push({ identity, role });
    const nextAcl: PyreelAclFile = {
      version: 1,
      grants: nextGrants,
      denies: acl.denies,
    };
    await writeAclFile(workspaceDir, nextAcl);

    return {
      handled: true,
      command: "rbac_grant",
      replyText: `Granted ${role} to ${identity}.`,
    };
  }

  if (subcommand === "revoke") {
    const identity = normalizeIdentity(tokens[1] ?? "");
    if (!identity) {
      return {
        handled: true,
        command: "rbac_revoke",
        replyText: "Usage: /pyreel rbac revoke <identity>",
      };
    }

    const nextAcl: PyreelAclFile = {
      version: 1,
      grants: acl.grants.filter((entry) => entry.identity !== identity),
      denies: acl.denies,
    };
    await writeAclFile(workspaceDir, nextAcl);
    return {
      handled: true,
      command: "rbac_revoke",
      replyText: `Revoked grant for ${identity}.`,
    };
  }

  return {
    handled: true,
    command: "rbac_status",
    replyText: "Use /pyreel rbac status|list|grant|revoke.",
  };
}

export async function addPyreelDeny(params: {
  workspaceDir: string;
  identity: string;
  reason?: string;
}): Promise<void> {
  const acl = await readAclFile(params.workspaceDir);
  const normalizedIdentity = normalizeIdentity(params.identity);
  const denies = (acl.denies ?? []).filter((entry) => entry.identity !== normalizedIdentity);
  denies.push({ identity: normalizedIdentity, reason: params.reason });
  await writeAclFile(params.workspaceDir, { version: 1, grants: acl.grants, denies });
}
