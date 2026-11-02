FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p remote-acp-relay

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --home /var/lib/remote-acp relay && mkdir -p /var/lib/remote-acp && chown relay /var/lib/remote-acp
COPY --from=build /src/target/release/remote-acp-relay /usr/local/bin/remote-acp-relay
USER relay
VOLUME /var/lib/remote-acp
EXPOSE 8787
ENTRYPOINT ["remote-acp-relay", "--config", "/etc/remote-acp/relay.json"]
