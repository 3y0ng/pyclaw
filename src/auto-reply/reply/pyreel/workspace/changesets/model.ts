export const CHANGESET_STATUSES = [
  "draft",
  "awaiting_confirmation",
  "applied",
  "rejected",
  "failed",
] as const;

export type ChangeSetStatus = (typeof CHANGESET_STATUSES)[number];

export type ChangeSetAuditEvent = {
  id: string;
  changesetId: string;
  at: string;
  kind:
    | "changeset_created"
    | "confirmation_issued"
    | "apply_confirmed"
    | "apply_rejected"
    | "apply_failed";
  metadata?: Record<string, string | number | boolean | null>;
};

export type ChangeSetRecord = {
  id: string;
  status: ChangeSetStatus;
  createdAt: string;
  updatedAt: string;
  dryRunRequest: string;
  confirmation?: {
    code: string;
    issuedAt: string;
    expiresAt: string;
  };
  appliedAt?: string;
};
