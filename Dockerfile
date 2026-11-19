# Triathlon Coach — single-user app. State lives in /data (mount a volume there).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Runtime dependencies only (the Anthropic SDK); TypeScript runs natively on Node 22.18+.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip Windows line endings if the script was checked out with them (they make the shebang fail), then make it executable.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

# Defaults for a hosted deployment; APP_PASSWORD must be provided as a secret.
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
EXPOSE 8080

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.ts"]
