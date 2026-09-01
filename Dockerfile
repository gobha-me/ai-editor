# syntax=docker/dockerfile:1

# Immutable build/runtime inputs. Keep the human-readable tags for update
# discovery; the digests are the authority used by every build.
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS vendor-build

WORKDIR /build

COPY vendor/package.json vendor/package-lock.json ./
RUN npm ci --ignore-scripts \
    && npm audit --audit-level=moderate

COPY vendor/codemirror-entry.mjs vendor/preact-htm-entry.mjs ./
RUN ./node_modules/.bin/esbuild codemirror-entry.mjs \
        --bundle \
        --format=esm \
        --minify \
        --outfile=codemirror-bundle.js \
        --target=es2020 \
        --tree-shaking=true \
    && ./node_modules/.bin/esbuild preact-htm-entry.mjs \
        --bundle \
        --format=esm \
        --minify \
        --outfile=preact-htm-bundle.js \
        --target=es2020 \
        --tree-shaking=true \
    && cp node_modules/marked/lib/marked.umd.js marked.min.js \
    && cp node_modules/dompurify/dist/purify.min.js purify.min.js \
    && cp node_modules/jszip/dist/jszip.min.js jszip.min.js \
    && cp node_modules/htmx.org/dist/htmx.min.js htmx.min.js \
    && test -s codemirror-bundle.js \
    && test -s preact-htm-bundle.js \
    && test -s marked.min.js \
    && test -s purify.min.js \
    && test -s jszip.min.js \
    && test -s htmx.min.js

FROM nginx:1-alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913

ARG VCS_REF=""
ARG VERSION=""

LABEL org.opencontainers.image.title="AI Editor" \
      org.opencontainers.image.description="Browser-based code editor with integrated AI assistance" \
      org.opencontainers.image.url="https://github.com/gobha-me/ai-editor" \
      org.opencontainers.image.source="https://github.com/gobha-me/ai-editor" \
      org.opencontainers.image.vendor="gobha-me" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}"

ENV BASE_PATH=/

COPY index.html /usr/share/nginx/html/
COPY CHANGELOG.md /usr/share/nginx/html/
COPY assets /usr/share/nginx/html/assets
COPY css /usr/share/nginx/html/css
COPY docs /usr/share/nginx/html/docs
COPY html /usr/share/nginx/html/html
COPY js /usr/share/nginx/html/js
COPY plugins /usr/share/nginx/html/plugins
COPY swaggers /usr/share/nginx/html/swaggers
COPY --from=vendor-build /build/codemirror-bundle.js /usr/share/nginx/html/vendor/
COPY --from=vendor-build /build/preact-htm-bundle.js /usr/share/nginx/html/vendor/
COPY --from=vendor-build /build/marked.min.js /usr/share/nginx/html/vendor/
COPY --from=vendor-build /build/purify.min.js /usr/share/nginx/html/vendor/
COPY --from=vendor-build /build/jszip.min.js /usr/share/nginx/html/vendor/
COPY --from=vendor-build /build/htmx.min.js /usr/share/nginx/html/vendor/

RUN rm -f /etc/nginx/conf.d/default.conf

COPY 20-configure-base-path.sh /docker-entrypoint.d/20-configure-base-path.sh
RUN chmod +x /docker-entrypoint.d/20-configure-base-path.sh

EXPOSE 8000
