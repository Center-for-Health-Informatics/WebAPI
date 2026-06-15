FROM node:lts-slim

RUN apt-get update && apt-get install -y --no-install-recommends default-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY migrations/ ./migrations/
COPY lib/circe.jar ./lib/circe.jar

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
