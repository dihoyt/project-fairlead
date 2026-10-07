# Debian-based on purpose: better-sqlite3 ships no musl prebuild.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client/package.json client/package-lock.json client/
RUN npm --prefix client ci
COPY . .
RUN npm run build && npm run build:client

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    DATA_DIR=/data \
    GIT_SHA=${GIT_SHA}
WORKDIR /app
# product.json sits beside dist/ because src/product.ts resolves it one level up.
COPY product.json package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/public public
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/index.js"]
