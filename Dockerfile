FROM node:20-bookworm-slim

# build nástroje pro nativní kompilaci better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# data (SQLite + stažené titulky) → připoj sem persistent volume v Coolify
ENV DATA_DIR=/data
ENV PORT=8080
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "server.js"]
