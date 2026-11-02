# Provider compliance

Policy registry: `crates/bridge-core/src/providers.rs::policy_for`. Change a mode there to disable it everywhere.

| Provider | Mode | Website use | Why |
|---|---|---|---|
| Codex | ChatGPT sign-in (official `codex login`) | Allowed **with notice**; user must acknowledge at consent | Codex supports ChatGPT plan usage in local clients; usage counts against the user's plan. Validate the intended third-party hosted workflow with OpenAI before marketing it as subscription-powered. |
| Codex | API key (`codex login --with-api-key`) | Allowed | Billed to the user's OpenAI API account |
| Claude | Subscription / Claude.ai login | **Blocked** | Anthropic's Claude Code legal terms restrict routing consumer subscription credentials for third-party products |
| Claude | Anthropic API key | Allowed | Stored in OS keychain; passed only to the local adapter; isolated `CLAUDE_CONFIG_DIR` |
| Custom ACP agent | — | Allowed with notice | Not verified; executable hash pinned at add time |

The bridge never reads `~/.codex`, `~/.claude`, Keychain items of other apps, or browser cookies. Provider marks are not shipped; plain-text initials are used. Re-check terms before commercial distribution.
