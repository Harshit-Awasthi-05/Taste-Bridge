FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=4000 \
    DATABASE_PATH=/app/data/taste-bridge.db \
    PATH=/app/node_modules/.bin:$PATH
WORKDIR /app

RUN npm install --global @qloo/qloo-harness@0.1.26 \
  && mkdir -p /app/data \
  && chown node:node /app/data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/schema.sql ./server/schema.sql
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist

USER node
EXPOSE 4000
VOLUME ["/app/data"]
CMD ["node", "server/dist/index.js"]
