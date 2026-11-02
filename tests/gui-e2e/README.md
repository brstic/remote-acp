# GUI end-to-end (macOS, real app window)

Drives the **built desktop app** with real mouse/keyboard events (CGEvent) while a headless
browser acts as the website user. Last run 2026-11-02 on the release `.app`: consent via the
deep link → Allow connection → task approval → permission "Allow once" → file written in the
chosen folder → Disconnect revoked on the relay.

```sh
swiftc -O -o /tmp/ui tests/gui-e2e/ui.swift        # needs Accessibility/PostEvent permission for the terminal
npm i playwright-core@1.49.1                        # any Chromium-based browser via BROWSER=
BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" DEMO_URL=http://127.0.0.1:3000/ OUT_DIR=/tmp node tests/gui-e2e/website.mjs &
open "$(cat /tmp/gui-link.txt)"                     # consent sheet appears in the app
/tmp/ui bounds "Remote ACP"                          # window id + frame; take screenshots with screencapture -l<id>
/tmp/ui click "Remote ACP" <x> <y>                   # window-relative points
/tmp/ui type "/path/to/project"
```
Coordinates depend on window size; take a `screencapture -l<id>` first and click the controls
it shows (folder field, Allow connection, Allow task, Allow once).
