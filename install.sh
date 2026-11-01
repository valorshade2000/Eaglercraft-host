#!/usr/bin/env bash
# eaglan-host installer for a Linux desktop (no root needed).
#   ./install.sh              install dependencies, then run:  node cli.js ui
#   ./install.sh --service    also install + start a systemd *user* service (starts at login)
#   ./install.sh --uninstall-service
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR="$(pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/eaglan-host.service"

if [[ "${1:-}" == "--uninstall-service" ]]; then
  systemctl --user disable --now eaglan-host.service 2>/dev/null || true
  rm -f "$UNIT" && systemctl --user daemon-reload
  echo "Service removed. Worlds in $APP_DIR/data were left untouched."
  exit 0
fi

# Node.js >= 22.13 is required (built-in node:sqlite).
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js 22.13+ (e.g. https://nodejs.org or your distro's nodesource/nvm package) and re-run." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node.js $(node -v) is too old; 22.13 or newer is required." >&2
  exit 1
fi
echo "Using Node.js $(node -v) at $NODE_BIN"

# node-datachannel (WebRTC) needs a native binary. Its installer downloads it from the package's
# release page unless a local copy is present: put node-datachannel-v<ver>-napi-v8-linux-<arch>.tar.gz
# into ./prebuilds/ (or set EAGLAN_PREBUILDS_DIR) to install with no download at all.
PREBUILDS_DIR="${EAGLAN_PREBUILDS_DIR:-$APP_DIR/prebuilds}"
ARCH="$(node -p process.arch)"
LIBC=""; if ldd --version 2>&1 | grep -qi musl; then LIBC="musl"; fi
LOCAL_TGZ="$(ls "$PREBUILDS_DIR"/node-datachannel-v*-napi-v*-linux${LIBC}-${ARCH}.tar.gz 2>/dev/null | tail -n 1 || true)"

echo "Installing dependencies..."
if [[ -n "$LOCAL_TGZ" ]]; then
  echo "Using the local WebRTC binary $LOCAL_TGZ (nothing is downloaded for it)"
  npm ci --omit=dev --no-audit --no-fund --ignore-scripts
  tar -xzf "$LOCAL_TGZ" -C node_modules/node-datachannel
else
  npm ci --omit=dev --no-audit --no-fund
  node -e "require('node-datachannel')" 2>/dev/null || npm rebuild node-datachannel
fi
node -e "require('node-datachannel'); require('node:sqlite'); console.log('native deps OK')"

echo "Running the integrated-server smoke test..."
node test/worker-smoke.js "$(mktemp -u /tmp/eaglan-smoke-XXXXXX.sqlite)" | grep -E 'SERVER (STARTED|STOPPED)' || { echo "Smoke test failed" >&2; exit 1; }
rm -f /tmp/eaglan-smoke-*.sqlite*

if [[ "${1:-}" == "--service" ]]; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT" <<EOF
[Unit]
Description=Eaglercraft World LAN headless host (UI on http://127.0.0.1:8090/)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN cli.js ui
Environment=BIND=127.0.0.1
Environment=PORT=8090
Environment=EAGLAN_AUTOSTART=last
Environment=EAGLAN_STOP_HOST_ON_EXIT=1
KillMode=mixed
TimeoutStopSec=120
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now eaglan-host.service
  echo
  echo "Service installed and started. Open http://127.0.0.1:8090/"
  echo "  status:  systemctl --user status eaglan-host"
  echo "  logs:    journalctl --user -u eaglan-host -f   (host log: $APP_DIR/data/logs/host.log)"
  echo "  To keep hosting while logged out: sudo loginctl enable-linger $USER"
else
  echo
  echo "Done. Start the UI with:   node cli.js ui     then open http://127.0.0.1:8090/"
  echo "(Run ./install.sh --service to start it automatically at login.)"
fi
