FROM node:20-alpine

RUN apk add --no-cache bash

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/github/package.json packages/github/package.json
COPY packages/storage/package.json packages/storage/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm dashboard:build

ENV NODE_ENV=production
ENV PORT=3000
ENV DASHBOARD_STATIC_DIR=/app/apps/dashboard/dist

EXPOSE 3000

CMD ["pnpm", "start:fly"]
