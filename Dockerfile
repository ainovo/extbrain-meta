FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Default `build` stays unlocked; pass --build-arg BUILD_MODE=build:cloudrun
# for the locked Cloud Run bundle (needs .env.cloudrun in context).
ARG BUILD_MODE=build
RUN npm run $BUILD_MODE

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package*.json ./
RUN npm install --omit=dev && npm install tsx
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/server ./server
COPY --from=builder --chown=node:node /app/src/lib ./src/lib
RUN chown -R node:node /app
# Never run as root: limits what a compromised process can do in the image.
USER node
EXPOSE 8080
CMD ["npx", "tsx", "server/index.ts"]
