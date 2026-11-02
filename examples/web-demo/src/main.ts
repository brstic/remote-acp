import { createDemoServer } from "./app.js";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`[web-demo] missing required env ${name}. See examples/web-demo/README.md`);
    process.exit(1);
  }
  return v;
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const server = createDemoServer({
  relayUrl: env("RELAY_URL", "http://127.0.0.1:8787"),
  serviceId: env("REMOTE_ACP_SERVICE_ID", "svc_demo"),
  serviceSecret: env("REMOTE_ACP_SERVICE_SECRET"),
  secureCookies: process.env.COOKIE_SECURE === "1",
});

server.listen(port, host, () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  // Machine-readable line used by the e2e test.
  console.log(JSON.stringify({ event: "listening", port: actual }));
  console.log(`[web-demo] Acme Notes (DEMO) on http://localhost:${actual}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
