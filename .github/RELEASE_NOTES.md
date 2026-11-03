First public preview of **Remote ACP Bridge**. Use the AI coding agent on your own computer (Codex or Claude Code, through their official ACP adapters) from websites you trust. Sign-in, files, permissions and execution stay on your machine.

### Downloads
| | |
|---|---|
| macOS (Apple Silicon) | `Remote ACP Bridge_*_aarch64.dmg` |
| macOS (Intel) | `Remote ACP Bridge_*_x64.dmg` |
| Windows | `.msi` or `-setup.exe` |
| Linux | `.AppImage`, `.deb` or `.rpm` |
| Relay server | `remote-acp-relay-*` binaries, or `ghcr.io/brstic/remote-acp/relay` (Docker) |

Checksums: `SHA256SUMS.txt`.

> ⚠️ **Preview builds are not code-signed or notarized.** macOS: right-click the app and choose **Open**, or run `xattr -dr com.apple.quarantine "/Applications/Remote ACP Bridge.app"`. Windows: in SmartScreen, click **More info**, then **Run anyway**.

### Getting started
1. Install the app. In **AI Providers**, install the connector for Codex and/or Claude Code and sign in with the official flow (the built-in Test agent needs no account).
2. Run a relay (`remote-acp-relay --config relay.json`, see `docs/deployment.md`) or use the demo setup from the README.
3. Try the examples, starting with **Bugboard** (`examples/issue-tracker`): "Fix with my agent" on a bug report.

### What's in this preview
- Desktop app (macOS, Windows, Linux): consent per website, per-task approval, local permission prompts, restricted agent modes, an output firewall, live Activity chat, diagnostics and an audit log.
- Relay: pairing, routing, SSE streaming with resume, revocation, rate limits.
- `@remote-acp/web-sdk`: pairing, tasks, website instructions and tools (MCP), auto-resuming streams.
- Examples: Bugboard, minimal integration, code review assistant, docs generator, chat demo.

Known limitations: unsigned builds, no auto-update, no hosted public relay yet. See `PROGRESS.md`.
