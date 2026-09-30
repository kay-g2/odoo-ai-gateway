# The build stage runs on the builder's own platform: dist/ and the pruned node_modules are pure JS.
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine
LABEL org.opencontainers.image.source="https://github.com/kay-g2/odoo-ai-gateway" \
      org.opencontainers.image.description="Self-hosted replacement for Odoo 20's AI service (ai.api.odoo.com)" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The base image's unprivileged "node" user, by id so orchestrators can verify it is not root.
USER 1000:1000
EXPOSE 8080
# Mount your config at /app/gateway.config.yaml or set ODOO_AI_GATEWAY_CONFIG.
CMD ["node", "dist/index.js"]
