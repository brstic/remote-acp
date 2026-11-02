# Troubleshooting

- **"Offline" in the app** — the relay isn't reachable. Check Settings → Relay address; Diagnostics shows the last error.
- **Codex "Setup needed"** — click *Install connector* (needs Node.js 22+ and npm). "Adapter files changed on disk" means the installed connector no longer matches what was verified; reinstall.
- **Codex "Sign in needed"** — *Sign in with ChatGPT* opens the official browser flow; the card updates when done.
- **Claude "Sign in needed"** — click *Sign in to Claude* (runs the official `claude auth login`), then Recheck.
- **Pairing link does nothing** — the app must be installed (deep link `remoteacp://`). Paste the link or the code into *Connect a website* instead.
- **"This link is for a different relay"** — the website uses another relay than your app. Change it only if you trust it.
- **Task stopped with `sandbox_unavailable`** — the agent couldn't be put in a restricted mode; update the connector.
- **Link opens nothing although the app is running** — another copy of the app (e.g. an old build) is registered for `remoteacp://`. Delete it and run `lsregister -f "/Applications/Remote ACP Bridge.app"`.
