# The Maximus Breakdown - YouTube Render Node
# Stitches MP3 audio + high-contrast thumbnail into a 1080p .mp4 for YouTube upload
FROM node:20-alpine

RUN apk add --no-cache ffmpeg ca-certificates curl

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/tmp && chown -R app:app /app
    USER app

    ENV PORT=8080
    ENV NODE_ENV=production
    EXPOSE 8080

    HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
      CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

      CMD ["node", "server.js"]
      
