# The gasrescue MCP server over stdio, for registries that build and inspect servers (such as Glama).
# Without GASRESCUE_EVM_PRIVATE_KEY it signs nothing.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js tools.js ./
USER node
ENTRYPOINT ["node", "server.js"]
