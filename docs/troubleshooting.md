# Troubleshooting

- **"Offline" in the app** — the relay isn't reachable. Check Settings → Relay address; Diagnostics shows the last error.
- **Codex "Setup needed"** — click *Install connector* (needs Node.js 22+ and npm). "Adapter files changed on disk" means the installed connector no longer matches what was verified; reinstall.
- **Codex "Sign in needed"** — *Sign in with ChatGPT* opens the official browser flow; the card updates when done.
- **Claude not offered to websites** — subscription sign-in is not allowed for website use; add an Anthropic API key.
- **Pairing link does nothing** — the app must be installed (deep link `remoteacp://`). Paste the link or the code into *Connect a website* instead.
- **"This link is for a different relay"** — the website uses another relay than your app. Change it only if you trust it.
- **Task stopped with `sandbox_unavailable`** — the agent couldn't be put in a restricted mode; update the connector.
- **Linux without a keyring** — the relay credential is kept in memory; the computer re-registers after each restart (Diagnostics shows a warning).
- **Link opens nothing although the app is running** — another copy of the app (e.g. an old build) is registered for `remoteacp://`. Delete it and run `lsregister -f "/Applications/Remote ACP Bridge.app"`.
- **macOS asks for your keychain password at start** — the keychain item was created by a differently signed build. Choose *Always Allow*, or delete the `com.remoteacp.bridge` item in Keychain Access; the app re-registers.
