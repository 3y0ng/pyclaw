# Pyreel discovery map (no implementation yet)

## Channel adapters + routing surfaces

- **Slack adapter/runtime**
  - `src/slack/monitor/message-handler/prepare.ts`
    - `resolveSlackRoutingContext(...)` calls `resolveAgentRoute(...)` and derives chat/thread session keys.
  - `src/slack/monitor/message-handler.ts`
    - `createSlackMessageHandler(...)` is the inbound debounce/dispatch entry for Slack events.
- **Microsoft Teams adapter/runtime (extension channel plugin)**
  - `extensions/msteams/src/channel.ts`
    - `msteamsPlugin` defines channel metadata/capabilities/onboarding/pairing/messaging hooks.
  - `extensions/msteams/src/monitor-handler/message-handler.ts`
    - inbound activity handler resolves route via `core.channel.routing.resolveAgentRoute(...)`.
- **WhatsApp adapter/runtime**
  - `src/web/auto-reply/monitor.ts`
    - `monitorWebChannel(...)` owns connection loop and seeds route/session events for WhatsApp.
  - `src/web/auto-reply/monitor/on-message.ts`
    - `createWebOnMessageHandler(...)` resolves per-message routes via `resolveAgentRoute(...)`.
- **Shared route resolver**
  - `src/routing/resolve-route.ts`
    - `resolveAgentRoute(...)` + `buildAgentSessionKey(...)` are core channel→agent/session routing primitives.

## Agent runtime loop + tool execution layer

- `src/agents/pi-embedded-runner/run.ts`
  - `runEmbeddedPiAgent(...)` is the outer runtime loop/retry coordinator.
- `src/agents/pi-embedded-runner/run/attempt.ts`
  - `runEmbeddedAttempt(...)` path builds prompt/tools/context for each attempt.
- `src/agents/pi-tools.ts`
  - `createOpenClawCodingTools(...)` composes toolsets, applies policy, wraps hooks.
- `src/agents/openclaw-tools.ts`
  - `createOpenClawTools(...)` registers core tool factories (browser, message, sessions, web, etc.) and plugin tools.

## Where SOUL.md / AGENTS.md / USER.md are loaded and injected

- `src/agents/workspace.ts`
  - `loadWorkspaceBootstrapFiles(...)` reads `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, etc.
- `src/agents/bootstrap-files.ts`
  - `resolveBootstrapContextForRun(...)` selects/files context bootstrap set for each run.
- `src/agents/pi-embedded-helpers/bootstrap.ts`
  - `buildBootstrapContextFiles(...)` trims/caps injected bootstrap file contents.
- `src/agents/system-prompt.ts`
  - `buildEmbeddedSystemPrompt(...)` injects `contextFiles`; includes explicit SOUL.md persona guidance when present.

## Skills/tools registration (and MCP integration touchpoints)

- `src/agents/skills.ts` + `src/agents/pi-embedded-runner/skills-runtime.ts`
  - `resolveSkillsPromptForRun(...)` and `resolveEmbeddedRunSkillEntries(...)` load skill entries/prompt blocks.
- `src/plugins/tools.ts`
  - `resolvePluginTools(...)` loads/merges plugin-provided tools into runtime toolset.
- `src/acp/translator.ts`
  - ACP accepts `mcpServers` in protocol payloads but currently logs and ignores them (`newSession`/`loadSession`).
- `src/memory/qmd-manager.ts`
  - QMD has optional MCP runtime bridge via mcporter (`memory.qmd.mcporter.*` config).

## Secrets/config storage + loading

- `src/config/io.ts`
  - `createConfigIO(...).loadConfig()` and top-level `loadConfig()` read/validate/normalize config.
- `src/config/paths.ts`
  - `resolveStateDir(...)`, `resolveConfigPath(...)`, `resolveOAuthDir(...)`, `resolveOAuthPath(...)` define filesystem locations.
- `src/agents/auth-profiles/store.ts`
  - `loadAuthProfileStore(...)`, `loadAuthProfileStoreForAgent(...)` load auth profile secrets (api_key/token/oauth) and sync external CLI creds.
- `src/commands/onboard-auth.credentials.ts`
  - helpers like `setAnthropicApiKey(...)`, `setOpenaiApiKey(...)`, `writeOAuthCredentials(...)` persist credentials.

## Files to touch next (implementation plan)

1. `src/agents/system-prompt.ts` — add Pyreel persona scaffolding in runtime/system prompt composition while preserving existing SOUL precedence.
2. `src/agents/workspace.ts` and/or `src/agents/bootstrap-files.ts` — ensure Pyreel-specific workspace bootstrap defaults are discoverable without breaking AGENTS/SOUL/USER semantics.
3. `src/agents/pi-embedded-runner/run/attempt.ts` — wire a product identity switch (`Pyreel`) into prompt assembly and runtime labels.
4. `src/agents/openclaw-tools.ts` + `src/agents/pi-tools.ts` — audit and optionally constrain/extend tools for performance-marketing workflows.
5. `src/routing/resolve-route.ts` — confirm no behavior changes needed; add tests if any channel/agent routing defaults are adjusted for productization.
6. `src/slack/monitor/message-handler/prepare.ts` — validate Slack inbound context remains compatible with Pyreel behavior.
7. `extensions/msteams/src/channel.ts` and `extensions/msteams/src/monitor-handler/message-handler.ts` — verify Teams plugin metadata/help text + routing compatibility.
8. `src/web/auto-reply/monitor.ts` and `src/web/auto-reply/monitor/on-message.ts` — verify WhatsApp runtime + route metadata still consistent.
9. `src/config/schema.help.ts` / relevant docs in `docs/channels/*` or product docs — update operator-facing wording for Pyreel branding while preserving OpenClaw runtime capabilities.
10. Add/update tests near touched runtime/prompt/tool files (especially prompt snapshots and routing invariants) before rollout.
