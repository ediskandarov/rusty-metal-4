# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM rust:1.95-slim-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc-x86-64-linux-gnu libc6-dev-amd64-cross && rm -rf /var/lib/apt/lists/*
RUN rustup target add x86_64-unknown-linux-gnu
WORKDIR /source
COPY network/Cargo.toml network/Cargo.lock network/build.rs network/
COPY network/src network/src
COPY network/examples network/examples
COPY config/resources.json config/resources.json
COPY build/release/server bundle
ENV TM4_SERVER_BUNDLE=/source/bundle \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc
WORKDIR /source/network
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/source/network/target \
    cargo build --locked --release --target x86_64-unknown-linux-gnu --features embedded-server --bin tm4-deathmatch-server -j 4 && \
    cp target/x86_64-unknown-linux-gnu/release/tm4-deathmatch-server /server

FROM debian:trixie-slim
COPY --from=build /server /usr/local/bin/rustymetal4-server
USER 65532:65532
ENV TM4_HTTP_LISTEN=0.0.0.0:8120 TM4_MATCH_LISTEN=0.0.0.0:8122 TM4_BEHIND_PROXY=1 TM4_JOURNAL_DIR=/tmp/tm4-journals
EXPOSE 8120 8122
ENTRYPOINT ["rustymetal4-server", "--serve", "2"]
