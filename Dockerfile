# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

# ---- build: install all deps, compile TypeScript, then drop devDependencies
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: only compiled code + production deps
FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
# Files stay root-owned so the app user cannot modify its own code.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Numeric UID (the image's `node` user) so Kubernetes `runAsNonRoot` can verify it.
USER 1000:1000
EXPOSE 3000
CMD ["node", "dist/main.js"]
