FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV GATEWAY_DB_PATH=/app/data/gateway.db
VOLUME ["/app/data"]
CMD ["node", "--experimental-strip-types", "src/cli.ts", "run"]
