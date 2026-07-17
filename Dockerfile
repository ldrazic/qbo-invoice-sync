FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# tsx at runtime keeps the migrations path (src/models/db/migrations) intact;
# fine for a demo deployment, a real build step would compile + copy assets.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
