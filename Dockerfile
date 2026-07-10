FROM node:lts-slim

RUN apt-get update && apt-get install -y --no-install-recommends default-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY src/ ./src/
COPY migrations/ ./migrations/
COPY lib/circe.jar ./lib/circe.jar

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
