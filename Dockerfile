# Headless Eaglercraft World LAN host. CPU only: no GPU, X server or browser in the image.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    EAGLAN_DATA=/data \
    BIND=0.0.0.0 \
    PORT=8090 \
    EAGLAN_STOP_HOST_ON_EXIT=1

# node-datachannel downloads its prebuilt linux binary (glibc >= 2.30) during install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && (node -e "require('node-datachannel')" || npm rebuild node-datachannel) \
 && node -e "require('node-datachannel'); require('node:sqlite'); console.log('native deps OK')" \
 && npm cache clean --force

COPY cli.js ./
COPY src ./src
COPY public ./public
COPY vendor ./vendor

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8090

# Use `docker run --init` (compose: init: true) so the detached host process is reaped
# and allow ~90s on stop for the world save (compose: stop_grace_period).
CMD ["node", "cli.js", "ui"]
