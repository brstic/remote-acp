import { createBugboardServer } from "./app.js";

const secret = process.env.REMOTE_ACP_SERVICE_SECRET;
if (!secret) {
  console.error("[bugboard] set REMOTE_ACP_SERVICE_SECRET (see README.md; `pnpm dev` sets the dev-only secret).");
  process.exit(1);
}

const server = createBugboardServer({
  relayUrl: process.env.RELAY_URL ?? "http://127.0.0.1:8787",
  serviceId: process.env.REMOTE_ACP_SERVICE_ID ?? "svc_bugboard",
  serviceSecret: secret,
  // Where the desktop agent reaches Bugboard's MCP tools (<PUBLIC_URL>/mcp).
  // Must be on the service's registered domain. Default: http://localhost:<PORT>.
  ...(process.env.PUBLIC_URL ? { publicUrl: process.env.PUBLIC_URL } : {}),
  secureCookies: process.env.COOKIE_SECURE === "1",
  ...(process.env.BUGBOARD_TOKEN_GRACE_MS ? { tokenGraceMs: Number(process.env.BUGBOARD_TOKEN_GRACE_MS) } : {}),
  // TEST ONLY (end-to-end tests play the agent's part with the run's token).
  exposeTokensForTests: process.env.BUGBOARD_E2E_EXPOSE_TOKENS === "1",
});

server.listen(Number(process.env.PORT ?? 3104), process.env.HOST ?? "127.0.0.1", () => {
  const { port } = server.address() as { port: number };
  console.log(JSON.stringify({ event: "listening", port })); // read by the e2e tests
  console.log(`[bugboard] Bugboard (EXAMPLE) on http://localhost:${port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
