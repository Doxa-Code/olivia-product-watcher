FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

COPY watcher.ts ./

RUN mkdir -p /app/data
WORKDIR /app/data

CMD ["bun", "run", "/app/watcher.ts", "--daemon"]
