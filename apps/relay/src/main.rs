use anyhow::Context;
use relay::{AppState, RelayConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let mut args = std::env::args().skip(1);
    let mut config_path = "relay.json".to_string();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--config" | "-c" => config_path = args.next().context("--config needs a path")?,
            "hash-secret" => {
                let secret = args.next().context("usage: remote-acp-relay hash-secret <secret>")?;
                println!("{}", bridge_protocol::ids::sha256_hex(&secret));
                return Ok(());
            }
            "new-secret" => {
                let secret = bridge_protocol::ids::random_token(32);
                println!("secret:       {secret}\nsecretSha256: {}", bridge_protocol::ids::sha256_hex(&secret));
                return Ok(());
            }
            "--help" | "-h" => {
                println!("remote-acp-relay [--config relay.json] | new-secret | hash-secret <secret>");
                return Ok(());
            }
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    let text = std::fs::read_to_string(&config_path).with_context(|| format!("reading {config_path}"))?;
    let cfg: RelayConfig = serde_json::from_str(&text).context("parsing relay config")?;
    let listen = cfg.listen.clone();
    let st = AppState::new(cfg)?;
    relay::verify_services(&st).await;
    let app = relay::app(st);
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    tracing::info!("relay listening on {listen}");
    axum::serve(listener, app).with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; }).await?;
    Ok(())
}
