FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# pandoc converts arXiv e-print LaTeX and pdftoppm (poppler-utils) draws its PDF
# figures, for the article importer (server/add-article/arxiv-latex.ts).
RUN apk add --no-cache bash git openssh-client pandoc-cli poppler-utils
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npm install -g @anthropic-ai/claude-code
COPY --from=builder /app/dist ./dist
COPY server/ ./server/
COPY shared/ ./shared/
EXPOSE 3000
CMD ["npx", "tsx", "server/prod-server.ts"]
