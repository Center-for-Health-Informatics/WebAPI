FROM node:lts-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY migrations/ ./migrations/

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
