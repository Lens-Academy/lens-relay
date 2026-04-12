FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-package-lock
COPY . .
RUN npx vite build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-package-lock
RUN npm install -g @anthropic-ai/claude-code
COPY --from=builder /app/dist ./dist
COPY server/ ./server/
COPY shared/ ./shared/
EXPOSE 3000
CMD ["npx", "tsx", "server/prod-server.ts"]
