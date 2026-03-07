# Pyreel mode reference

## Feature and safety flags

Pyreel mode is opt-in and write automation is default-off unless explicitly enabled.

```json
{
  "pyreel": {
    "mode": true,
    "features": {
      "proactive": true
    },
    "proactive": {
      "enabled": true,
      "timezone": "UTC"
    },
    "autoApply": {
      "enabled": false,
      "platforms": {
        "slack": false,
        "telegram": false
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
- `PYREEL_FEATURE_PROACTIVE`
- `PYREEL_PROACTIVE_ENABLED`
- `PYREEL_AUTO_APPLY`

Use `1` to enable and `0` (or empty) to disable.

## Command reference

Pyreel mode only accepts `/pyreel ...` commands. Non-`/pyreel` input is blocked when mode is on.

- `/pyreel help`
- `/pyreel whoami`
- `/pyreel rbac status|list|grant|revoke`
- `/pyreel brief|plan|research|scripts <request>`
- `/pyreel report|next <request>`
- `/pyreel apply --dry-run <request>`
- `/pyreel apply <changeset_id> <confirm_code>`
- `/pyreel apply --auto-apply <request>` (disabled by default, low-risk requests only)
- `/pyreel proactive on|off|status|schedule <daily|weekly>|allow|disallow|quiet-hours`

## Workspace layout

Pyreel workspace state is stored under `pyreel/workspace/`.

- `pyreel/workspace/acl.json`: RBAC grants/denies.
- `pyreel/workspace/state.json`: proactive controls, counters, and report idempotency keys.
- `pyreel/workspace/audit.jsonl`: append-only ChangeSet audit events.
- `pyreel/workspace/changesets/*.json`: ChangeSet records.
- `pyreel/workspace/workflow/<action>/*.md`: generated workflow artifacts (`brief`, `plan`, `research`, `scripts`, `report`, `next`).

## ChangeSet flow

1. Run `/pyreel apply --dry-run <request>`.
2. Router creates a ChangeSet in `awaiting_confirmation` with a six-digit confirmation code.
3. Confirm with `/pyreel apply <changeset_id> <confirm_code>` before the configured TTL (`pyreel.writes.confirmationTtlSeconds`, default `900`).
4. On success, ChangeSet transitions to `applied` and audit events are appended.
5. Re-apply attempts are rejected as `already_applied` (idempotent apply behavior).

Auto-apply (`/pyreel apply --auto-apply ...`) performs dry-run + confirm in one step, but only when:

- `pyreel.mode=true`
- write access is enabled for the current surface (`pyreel.writes`)
- `pyreel.autoApply.enabled=true`
- current surface is enabled in `pyreel.autoApply.platforms` when platform flags are defined
- the request passes low-risk filtering (destructive verbs such as `delete`, `drop`, or `remove` are rejected)

## RBAC roles and minimum command requirements

Pyreel roles are `viewer`, `operator`, `approver`, and `admin`.

- `viewer`: `/pyreel help`, `/pyreel whoami`, `/pyreel rbac status|list`, `/pyreel report`
- `operator`: workflow authoring commands (`brief|plan|research|scripts|next`)
- `approver`: `/pyreel apply ...`
- `admin`: `/pyreel proactive ...` and `/pyreel rbac grant|revoke`

Identity resolution supports scoped (`surface:identity`) and unscoped keys; high-risk commands (`apply`, `proactive`, `rbac grant|revoke`) require scoped identity grants.

## Proactive controls

Proactive reporting uses both config and persisted workspace state controls.

Execution gate checks:

1. `pyreel.mode=true`
2. `pyreel.features.proactive=true`
3. `pyreel.proactive.enabled=true`
4. persisted proactive state `enabled=on`
5. surface allowlist match (if configured)
6. identity allowlist match (if configured)
7. outside quiet-hours window
8. hourly/daily rate limits not exceeded
9. report idempotency key has not already been posted for the current daily/weekly window

When a proactive report is posted, counters and the daily/weekly posted key are updated in `state.json`.
