# Builds the anytype-ts web mode (entry.web.tsx) into static files.
#
# ANYTYPE_TS_REF is the frontend release. It must pair with the heart version
# the anytype-cli container runs: middleware.version in that release names the
# heart it was built against. scripts/pairing.sh picks it.
FROM node:24-bookworm AS build

ARG BUN_VERSION=1.4.4
ARG PROTOC_VERSION=23.4
RUN apt-get update && apt-get install -y --no-install-recommends git curl jq unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "bun@${BUN_VERSION}" \
 && curl -fsSL -o /tmp/protoc.zip "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip" \
 && unzip -q /tmp/protoc.zip -d /opt/protoc && rm /tmp/protoc.zip
ENV PATH="/opt/protoc/bin:${PATH}"

ARG ANYTYPE_TS_REF
RUN test -n "${ANYTYPE_TS_REF}" || (echo "ANYTYPE_TS_REF is required" >&2; exit 1)
WORKDIR /src
RUN git clone --depth 1 --branch "${ANYTYPE_TS_REF}" https://github.com/anyproto/anytype-ts.git .

# postinstall would rebuild native Electron modules (keytar), which the web
# mode never loads; patch-package is the part that matters.
RUN bun install --frozen-lockfile --ignore-scripts && bunx patch-package
# heart's JS assets (protos, generated JSON) for middleware.version.
RUN ./update.sh ubuntu-latest amd64 && rm -f dist/anytypeHelper
RUN bash scripts/generate-protos.sh --from-dist
RUN node ./electron/hook/locale.js
RUN bun run build:web && cat middleware.version > dist-web/MIDDLEWARE_VERSION \
 && echo "${ANYTYPE_TS_REF}" > dist-web/ANYTYPE_TS_REF

# The production web build emits only js/css/cmaps/wasm. Everything the app
# loads at runtime from the repo's dist/ (emoji and other images, fonts, embed
# sandboxes, workers) is served by the dev server in upstream's web mode, so
# it is copied in here.
FROM scratch AS out
COPY --from=build /src/dist/img /img
COPY --from=build /src/dist/font /font
COPY --from=build /src/dist/embed /embed
COPY --from=build /src/dist/workers /workers
COPY --from=build /src/dist/assets /assets
COPY --from=build /src/dist/audio /audio
COPY --from=build /src/dist-web /
