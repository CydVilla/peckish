# Peckish MCP server — introspection/CI image.
#
# Peckish is a LOCAL, macOS-only MCP server in normal use: it drives DoorDash's
# official dd-cli (an Apple Silicon binary, keychain auth) on the user's Mac.
# This image exists so registries and CI (e.g. Glama) can build the server,
# start it over stdio, and introspect its tools — the server only exec's
# dd-cli when a tool is CALLED, so initialize/tools-list work anywhere.
# Tool calls inside this container will return a clear "dd-cli binary not
# found" error by design.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# MCP over stdio — the default entrypoint for introspection.
CMD ["node", "dist/mcp.js"]
