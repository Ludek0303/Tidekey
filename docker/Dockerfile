# Build the Rust node, the formula WASM used by the browser UI and the preview frame's parsers (docs/PODGLAD-PLAN.md).
FROM rust:latest AS rust-build
# The commit and the public repository of this build: shown in "O programie" and by /api/source (AGPL-3.0 §13).
ARG NOTES_COMMIT=""
ARG NOTES_SOURCE_URL=""
ENV NOTES_COMMIT=$NOTES_COMMIT NOTES_SOURCE_URL=$NOTES_SOURCE_URL
WORKDIR /src
RUN sed -i 's#http://deb.debian.org#https://deb.debian.org#g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends clang \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-pack --locked
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY ui ./ui
COPY docker ./docker
RUN cargo build --locked --release -p notes-node \
    && cd ui \
    && wasm-pack build ../crates/web --target web --out-dir ../../ui/src/wasm --release \
    && bash scripts/build-preview-wasm.sh

# Build the static single-page application and the preview frame (/preview/) using the WASM artifacts above.
FROM node:22-bookworm-slim AS ui-build
ARG NOTES_COMMIT=""
ARG NOTES_SOURCE_URL=""
ENV NOTES_COMMIT=$NOTES_COMMIT NOTES_SOURCE_URL=$NOTES_SOURCE_URL
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
# the LGPL libraries the frame ships byte for byte (vendor/lgpl, checked against MANIFEST.json)
COPY vendor /src/vendor
COPY --from=rust-build /src/ui/src/wasm/ ./src/wasm/
COPY --from=rust-build /src/ui/preview/wasm/ ./preview/wasm/
COPY --from=rust-build /src/ui/preview/wasm-dwg/ ./preview/wasm-dwg/
# the licence and the notices kept in the repository (CI checks they match the dependencies): the build copies them
# into /web, and scripts/licencje/collect.mjs is the Vite plugin that does it
COPY LICENSE THIRD_PARTY_NOTICES.txt /src/
COPY scripts/licencje /src/scripts/licencje
# as `npm run build` without its wasm steps
RUN npx tsc --noEmit && npx vite build && npx vite build -c vite.preview.config.ts

# Distroless runtime: the node serves /health and the built browser app.
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
ARG NOTES_SOURCE_URL=""
LABEL org.opencontainers.image.title="Notatki (notes-node)" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="$NOTES_SOURCE_URL"
# the project's licence and the notices of every component (also of the base image's packages)
COPY --from=ui-build /src/LICENSE /src/THIRD_PARTY_NOTICES.txt /usr/share/doc/notes/
COPY --from=rust-build /src/target/release/notes-node /notes-node
COPY --from=ui-build /src/ui/dist /web
COPY --chown=65532:65532 --from=rust-build /src/docker/data /data
VOLUME ["/data"]
EXPOSE 8080/tcp
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
    CMD ["/notes-node", "health", "--http", "127.0.0.1:8080"]
ENTRYPOINT ["/notes-node", "serve", "--data", "/data", "--http", "0.0.0.0:8080", "--quic", "0.0.0.0:7842", "--web", "/web"]
