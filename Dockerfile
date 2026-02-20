# ============================================
# AI Editor - Multi-stage Docker Build
# ============================================
# Stage 1: Bundle vendor dependencies (CodeMirror, marked, DOMPurify)
# Stage 2: Slim production image with all assets baked in
#
# The final image requires NO internet access at runtime.
# ============================================

# --------------------------------------------------
# Stage 1: Vendor dependency bundling
# --------------------------------------------------
FROM node:22-slim AS vendor-build

WORKDIR /build

# Install wget for UMD library downloads
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Bundle CodeMirror into a single ESM file
COPY vendor/package.json vendor/codemirror-entry.mjs ./
RUN npm install --ignore-scripts \
    && npx esbuild codemirror-entry.mjs \
        --bundle \
        --format=esm \
        --minify \
        --outfile=codemirror-bundle.js \
        --target=es2020 \
        --tree-shaking=true

# Download UMD libraries (pinned versions for reproducibility)
RUN wget -q -O marked.min.js \
        "https://cdnjs.cloudflare.com/ajax/libs/marked/16.3.0/lib/marked.umd.min.js" \
    && wget -q -O purify.min.js \
        "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.4/purify.min.js" \
    && wget -q -O jszip.min.js \
        "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js" \
    && wget -q -O htmx.min.js \
        "https://cdnjs.cloudflare.com/ajax/libs/htmx/2.0.4/htmx.min.js"

# Verify downloads aren't empty
RUN test -s codemirror-bundle.js \
    && test -s marked.min.js \
    && test -s purify.min.js \
    && test -s jszip.min.js \
    && test -s htmx.min.js \
    && echo "All vendor files built successfully" \
    || (echo "ERROR: Vendor build produced empty files" && exit 1)

# Optional: @xenova/transformers for local embeddings (~15MB minified)
# Uncomment if you need browser-based embedding generation in air-gapped mode.
# Most deployments use server-side embeddings and don't need this.
# RUN wget -q -O transformers.min.js \
#         "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js"

# --------------------------------------------------
# Stage 2: Production image (nginx)
# --------------------------------------------------
FROM nginx:1-alpine

# OCI image metadata — overrides inherited nginx base image labels
LABEL org.opencontainers.image.title="AI Editor" \
      org.opencontainers.image.description="Browser-based code editor with integrated AI assistance" \
      org.opencontainers.image.url="https://github.com/gobha-me/ai-editor" \
      org.opencontainers.image.source="https://github.com/gobha-me/ai-editor" \
      org.opencontainers.image.vendor="gobha-me" \
      org.opencontainers.image.licenses="MIT" \
      maintainer=""

# Runtime configuration: set BASE_PATH to serve from a sub-path
# Examples: / (root), /editor, /test, /dev
ENV BASE_PATH=/

# Security headers and gzip configuration
COPY --from=vendor-build /build/codemirror-bundle.js /tmp/vendor/
COPY --from=vendor-build /build/marked.min.js        /tmp/vendor/
COPY --from=vendor-build /build/purify.min.js         /tmp/vendor/
COPY --from=vendor-build /build/jszip.min.js          /tmp/vendor/
COPY --from=vendor-build /build/htmx.min.js           /tmp/vendor/

# Copy application source
COPY . /usr/share/nginx/html/

# Copy vendor bundles into the served directory
COPY --from=vendor-build /build/codemirror-bundle.js /usr/share/nginx/html/vendor/
COPY --from=vendor-build /build/marked.min.js        /usr/share/nginx/html/vendor/
COPY --from=vendor-build /build/purify.min.js         /usr/share/nginx/html/vendor/
COPY --from=vendor-build /build/jszip.min.js          /usr/share/nginx/html/vendor/
COPY --from=vendor-build /build/htmx.min.js           /usr/share/nginx/html/vendor/

# Remove build-only files from final image
RUN rm -rf /usr/share/nginx/html/vendor/node_modules \
           /usr/share/nginx/html/vendor/package-lock.json \
           /usr/share/nginx/html/vendor/package.json \
           /usr/share/nginx/html/vendor/codemirror-entry.mjs \
           /usr/share/nginx/html/Dockerfile \
           /usr/share/nginx/html/deployment.yaml \
           /usr/share/nginx/html/nginx.conf \
           /usr/share/nginx/html/nginx.conf.template \
           /usr/share/nginx/html/docker-entrypoint.sh \
           /usr/share/nginx/html/20-configure-base-path.sh \
           /usr/share/nginx/html/.gitea \
    # Remove default nginx config (entrypoint.d script generates it)
    && rm -f /etc/nginx/conf.d/default.conf

# Startup hook: generates nginx config from BASE_PATH env var
COPY 20-configure-base-path.sh /docker-entrypoint.d/20-configure-base-path.sh
RUN chmod +x /docker-entrypoint.d/20-configure-base-path.sh

EXPOSE 8000
