# syntax=docker/dockerfile:1
# AperturePrism production images. The workspace compiles each app with its
# package sources inlined under <app>/dist (relative deep imports), so the
# runtime images only need root node_modules plus the app's dist tree.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/analysis-worker ./apps/analysis-worker
COPY apps/index-worker ./apps/index-worker
COPY apps/scheduler ./apps/scheduler
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.package.json eslint.config.mjs ./
RUN npm run build

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json

FROM base AS api
COPY --from=build /app/apps/api/dist ./apps/api/dist
EXPOSE 3000
CMD ["node", "apps/api/dist/apps/api/src/main.js"]

FROM base AS analysis-worker
COPY --from=build /app/apps/analysis-worker/dist ./apps/analysis-worker/dist
CMD ["node", "apps/analysis-worker/dist/apps/analysis-worker/src/main.js"]

FROM base AS index-worker
COPY --from=build /app/apps/index-worker/dist ./apps/index-worker/dist
CMD ["node", "apps/index-worker/dist/apps/index-worker/src/main.js"]

FROM base AS scheduler
COPY --from=build /app/apps/scheduler/dist ./apps/scheduler/dist
CMD ["node", "apps/scheduler/dist/apps/scheduler/src/main.js"]
