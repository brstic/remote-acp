import { createReviewServer } from "./app.js";

const secret = process.env.REMOTE_ACP_SERVICE_SECRET;
if (!secret) {
  console.error("[code-review] set REMOTE_ACP_SERVICE_SECRET (see README.md; `pnpm dev` sets the dev-only secret).");
  process.exit(1);
}

const server = createReviewServer({
  relayUrl: process.env.RELAY_URL ?? "http://127.0.0.1:8787",
  serviceId: process.env.REMOTE_ACP_SERVICE_ID ?? "svc_code_review",
  serviceSecret: secret,
  secureCookies: process.env.COOKIE_SECURE === "1",
});

server.listen(Number(process.env.PORT ?? 3102), process.env.HOST ?? "127.0.0.1", () => {
  const { port } = server.address() as { port: number };
  console.log(JSON.stringify({ event: "listening", port })); // read by the e2e test
  console.log(`[code-review] Code Review Assistant (EXAMPLE) on http://localhost:${port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
