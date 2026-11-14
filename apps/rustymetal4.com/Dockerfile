# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM rust:1.95-slim-trixie AS build
ARG BUILDARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils binutils && rm -rf /var/lib/apt/lists/*
# Native Rust compilation on both ARM Macs and x86 CI; Zig links the static x86-64 target.
RUN case "$BUILDARCH" in \
      arm64) zig_arch=aarch64; zig_sha=958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f ;; \
      amd64) zig_arch=x86_64; zig_sha=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239 ;; \
      *) exit 1 ;; \
    esac && \
    curl -fsSL "https://ziglang.org/download/0.15.2/zig-${zig_arch}-linux-0.15.2.tar.xz" -o /tmp/zig.tar.xz && \
    echo "$zig_sha  /tmp/zig.tar.xz" | sha256sum -c - && \
    mkdir /opt/zig && tar -xJf /tmp/zig.tar.xz --strip-components=1 -C /opt/zig && rm /tmp/zig.tar.xz
ENV PATH=/opt/zig:$PATH
RUN cargo install --locked cargo-zigbuild --version 0.24.1 && rustup target add x86_64-unknown-linux-musl
WORKDIR /source
COPY network/Cargo.toml network/Cargo.lock network/build.rs network/
COPY network/src network/src
COPY network/examples network/examples
COPY config/resources.json config/ffa.json config/
WORKDIR /source/network
# The binary does not embed the website or simulation. Updating Wasm leaves this layer cached.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/source/network/target \
    --mount=type=cache,target=/root/.cache \
    cargo zigbuild --locked --release --target x86_64-unknown-linux-musl --bin tm4-deathmatch-server -j 4 && \
    cp target/x86_64-unknown-linux-musl/release/tm4-deathmatch-server /server && \
    ! readelf -l /server | grep -q INTERP && \
    mkdir /runtime-tmp && chmod 1777 /runtime-tmp

FROM scratch AS simulation
COPY --from=build /server /compiler
COPY build/release/server/tm4_standalone.wasm /simulation/tm4_standalone.wasm
COPY build/release/server/simulation-build.json /simulation/simulation-build.json
# Compile trusted game Wasm once when building the image; runtime Cranelift stays available for mods.
RUN ["/compiler", "--precompile-simulation", "/simulation/tm4_standalone.wasm", "/simulation/tm4_standalone.cwasm"]

FROM scratch
COPY --from=build /server /rustymetal4-server
COPY --from=build /runtime-tmp /tmp
COPY --from=simulation /simulation /simulation
COPY LICENSE /LICENSE
USER 65532:65532
ENV TMPDIR=/tmp \
    TM4_HTTP_LISTEN=0.0.0.0:8120 \
    TM4_MATCH_LISTEN=0.0.0.0:8122 \
    TM4_BEHIND_PROXY=1 \
    TM4_JOURNAL_DIR=/tmp/tm4-journals \
    TM4_SIMULATION_WASM=/simulation/tm4_standalone.wasm \
    TM4_SIMULATION_BUILD=/simulation/simulation-build.json \
    TM4_SIMULATION_PRECOMPILED=/simulation/tm4_standalone.cwasm
EXPOSE 8120 8122
ENTRYPOINT ["/rustymetal4-server", "--serve", "2"]
