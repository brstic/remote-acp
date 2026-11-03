#!/usr/bin/env bash
# Launch the real desktop app against a local relay and verify it registers
# and connects (used in CI on macOS, Windows and Linux).
set -euo pipefail
cd "$(dirname "$0")/.."
EXE=target/debug/remote-acp-desktop
RELAY=target/debug/remote-acp-relay
if [[ "${OS:-}" == "Windows_NT" ]]; then EXE="$EXE.exe"; RELAY="$RELAY.exe"; fi
WORK=$(mktemp -d)
# Native path for the relay's database (Git Bash /tmp paths mean nothing to Windows programs).
NATIVE_WORK="$WORK"
if command -v cygpath >/dev/null 2>&1; then NATIVE_WORK=$(cygpath -m "$WORK"); fi
HASH=$("$RELAY" hash-secret smoke-secret-0123456789)
cat > "$WORK/relay.json" <<JSON
{"listen":"127.0.0.1:8799","publicUrl":"http://127.0.0.1:8799","database":"$NATIVE_WORK/relay.sqlite3",
 "services":[{"id":"svc_smoke","displayName":"Smoke","origin":"http://localhost:3000","secretSha256":"$HASH","verification":"operator"}]}
JSON
"$RELAY" --config "$WORK/relay.json" > "$WORK/relay.log" 2>&1 &
RELAY_PID=$!
for i in $(seq 1 50); do curl -fs http://127.0.0.1:8799/healthz >/dev/null && break; sleep 0.2; done

export REMOTE_ACP_RELAY_URL=http://127.0.0.1:8799
LAUNCH=("$EXE")
if [[ "$(uname -s)" == "Linux" ]]; then LAUNCH=(xvfb-run -a dbus-run-session -- "$EXE"); fi
"${LAUNCH[@]}" > "$WORK/desktop.log" 2>&1 &
APP_PID=$!

ok=0
for i in $(seq 1 120); do
  if grep -q "desktop connected" "$WORK/relay.log"; then ok=1; break; fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then echo "desktop app exited early"; break; fi
  sleep 0.5
done
echo "--- relay log"; tail -5 "$WORK/relay.log"
echo "--- desktop log"; tail -20 "$WORK/desktop.log"
kill "$APP_PID" 2>/dev/null || true
if [[ "${OS:-}" == "Windows_NT" ]]; then taskkill //F //IM remote-acp-desktop.exe >/dev/null 2>&1 || true; fi
kill "$RELAY_PID" 2>/dev/null || true
if [[ $ok == 1 ]]; then echo "SMOKE OK: desktop app launched, registered and connected to the relay"; else echo "SMOKE FAILED"; exit 1; fi
