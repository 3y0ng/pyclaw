# Pyreel mode reference

## Feature and safety flags

Pyreel behavior is default-off. Proactive and auto-apply paths require explicit opt-in.

```json
{
  "pyreel": {
    "mode": true,
    "features": {
      "ingest": true,
      "remix": true,
      "export": true,
      "proactive": true
    },
    "proactive": {
      "enabled": true,
      "timezone": "UTC"
    },
    "autoApply": {
      "enabled": false,
      "platforms": {
        "slack": false
      }
    },
    "writes": {
      "enabled": true,
      "confirmationTtlSeconds": 900,
      "platforms": {
        "slack": true,
        "telegram": true
      }
    }
  }
}
```

Environment overrides:

- `PYREEL_MODE`
- `PYREEL_FEATURE_INGEST`
- `PYREEL_FEATURE_REMIX`
- `PYREEL_FEATURE_EXPORT`
- `PYREEL_FEATURE_PROACTIVE`
- `PYREEL_PROACTIVE_ENABLED`
- `PYREEL_AUTO_APPLY`

Use `1` to enable and `0` (or empty) to disable.

## Command list

- `/pyreel help`
- `/pyreel status`
- `/pyreel whoami`
- `/pyreel rbac status|list|grant|revoke`
- `/pyreel ingest`
- `/pyreel remix`
- `/pyreel export`
- `/pyreel apply --dry-run <request>`
- `/pyreel apply <changeset_id> <confirm_code>`
- `/pyreel apply --auto-apply <request>` (default disabled, low-risk only)
- `/pyreel brief|plan|research|scripts|report|next <request>`
- `/pyreel proactive <daily|weekly>`

## Workspace layout

Pyreel stores workspace data under `.pyreel`:

- `.pyreel/artifacts/`: generated workflow markdown artifacts.
- `.pyreel/workspace/changesets/`: ChangeSet records and audit log.
- `.pyreel/workspace/state/proactive.json`: proactive allowlists, quiet hours, rate limits, and idempotency state.
- `pyreel/workspace/acl.json`: RBAC grants/denies.

## ChangeSet flow

1. Operator runs `/pyreel apply --dry-run <request>`.
2. Router creates a ChangeSet in `awaiting_confirmation` status with a short-lived confirmation code.
3. Operator confirms with `/pyreel apply <changeset_id> <confirm_code>`.
4. ChangeSet transitions to `applied` and appends audit events.

For optional automation, `/pyreel apply --auto-apply <request>` creates a dry-run and confirms it immediately, but only when:

- `pyreel.mode=true`
- `pyreel.autoApply.enabled=true`
- current surface is allowlisted by `pyreel.autoApply.platforms` (if configured)
- request passes low-risk guardrails (destructive verbs are blocked)

## Proactive reporting flow

`/pyreel proactive <daily|weekly>` reuses cron schedule evaluation to compute next due windows and posts through the existing report workflow path.

Execution gate checks:

1. `pyreel.mode=true`
2. `pyreel.features.proactive=true`
3. `pyreel.proactive.enabled=true`
4. Workspace allowlist match (if configured)
5. Not in quiet hours
6. Rate limits not exceeded
7. Idempotency key for the daily or weekly window has not already been posted

When a report is posted, proactive state increments hour/day counters and updates the per-window idempotency key.

## RBAC model

Roles are `viewer`, `editor`, and `admin`.

- Viewer: read/status commands.
- Editor: workflow, report, proactive, and apply commands.
- Admin: RBAC management (`list`, `grant`, `revoke`).

Identity resolution uses multiple keys (surface-qualified and raw IDs/usernames) and optional deny entries. Deny rules override grants.
