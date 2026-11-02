# Providers

Both providers run **only through their official ACP adapters** with the user's **own official sign-in**. There is no API-key mode in the app.

| Provider | Adapter (pinned, integrity-checked) | Sign-in | Restricted mode used for website tasks |
|---|---|---|---|
| Codex | `@agentclientprotocol/codex-acp` 2.5.0 | `codex login` (ChatGPT) | `read-only` / `workspace-write` |
| Claude Code | `@agentclientprotocol/claude-agent-acp` 0.100.0 | `claude auth login` (Claude subscription) | `default` (asks before changes) / `acceptEdits` |
| Custom ACP agent | user-chosen executable (hash pinned) | agent's own | adapter-dependent |

The consent screen shows a notice that tasks count toward the user's plan limits, and the user confirms it. The bridge never reads `~/.codex`, `~/.claude`, Keychain items of other apps or browser cookies; sign-in status comes from the official CLIs (`codex login status`, `claude auth status`), and only the logged-in flag and plan name are used locally. Account identity sent by adapters (`_auth/status_update`) is never forwarded.

Intended use: a person using their own agent installation from sites they control. If you distribute this to other people for use with third-party websites, review OpenAI's and Anthropic's terms for that scenario first.
