# HAAS server image (Railway or any Docker host).
# Includes Python + uv and a pre-installed Fiverr MCP server, so Fiverr search works without a browser.
# Browser-read sites (PeoplePerHour, Guru) and messaging sellers need the operator's logged-in Chrome,
# which a server does not have: they are off here and those picks come back as links.
FROM ghcr.io/astral-sh/uv:0.9 AS uv
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# uv / uvx, and the Fiverr MCP server installed once at build time (no download on the first search).
# mcp<2: fiverr-mcp-server 0.1.x imports FastMCP, which mcp 2 renamed.
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_TOOL_DIR=/opt/uv/tools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN uv tool install --python 3.12 --with 'mcp[cli]<2' fiverr-mcp-server \
  && fiverr-mcp-server --help >/dev/null 2>&1 || true

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: the native addons (bufferutil, keccak, bigint-buffer...) are optional
# accelerators with pure-JS fallbacks; skipping them matches the tested local setup and
# keeps the slim image free of a C++ toolchain. esbuild works via its platform packages.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .

ENV NODE_ENV=production \
    HAAS_HOME=/data \
    DB_PATH=/data/haas.db \
    PORT=8787 \
    FIVERR_SEARCH=mcp \
    FIVERR_MCP_COMMAND=fiverr-mcp-server \
    FIVERR_MCP_ARGS="" \
    BROWSER_SOURCES=false \
    BROWSER_CONTACT=false
# Persistent data: attach a Railway volume (or docker -v) at /data.
EXPOSE 8787
# The slim image has no curl; node's own fetch probes /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "start"]
