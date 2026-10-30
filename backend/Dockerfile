# Stage 1 : Build - compilation de better-sqlite3 et tests (outils de compilation non conserves)
FROM node:24-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Tests (node:test) : un échec interrompt le build
COPY . .
RUN npm test

# Stage 2 : Production
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 3000
CMD ["node", "server.js"]
