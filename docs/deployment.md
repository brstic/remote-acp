# Deployment

## Relay
```
cargo build --release -p remote-acp-relay
remote-acp-relay new-secret            # prints a service secret + its sha256
remote-acp-relay --config relay.json
```
`relay.json`:
```json
{"listen":"0.0.0.0:8787","publicUrl":"https://relay.example.com","database":"/var/lib/remote-acp/relay.sqlite3",
 "services":[{"id":"svc_acme","displayName":"Acme Notes","origin":"https://app.acme.com",
              "secretSha256":"<sha256>","verification":"well_known"}]}
```
`verification`: `operator` (you vetted the origin), `well_known` (relay fetches `<origin>/.well-known/remote-acp.json` with `{"serviceId":"svc_acme"}` at startup), `unverified` (dev only; desktops warn). Terminate TLS in front (Caddy/nginx) — desktops require `https`/`wss` except for localhost. Single node; state for live tasks is in memory, connections/desktops in SQLite.

## Desktop
`pnpm --dir apps/desktop tauri build` (needs Rust, Node 22+, platform toolchain). Set the relay in Settings, or `REMOTE_ACP_RELAY_URL` at launch. Production releases need signing/notarization (not configured here).

## Public relay with Docker + automatic TLS
`deploy/relay/`: `Dockerfile`, `docker-compose.yml` (relay + Caddy with Let's Encrypt), `Caddyfile`, `relay.example.json`.
```
cd deploy/relay && cp relay.example.json relay.json   # edit services
RELAY_DOMAIN=relay.example.com docker compose up -d
```
Then set `https://relay.example.com` as the relay in the desktop app (or ship it as the default via `REMOTE_ACP_RELAY_URL` / `DEFAULT_RELAY_URL`).

## Signed releases
`.github/workflows/release.yml` builds macOS (arm64 + x64 DMG), Windows (MSI + NSIS) and Linux (deb, rpm, AppImage) on tag `v*`, runs all tests first, writes SHA256SUMS, and publishes the relay image to GHCR. macOS signing/notarization activates when the `APPLE_*` repository secrets are set (Developer ID certificate, Apple ID app password, team id). Windows Authenticode signing: add `bundle.windows.certificateThumbprint` or a `signCommand` once a certificate exists.
