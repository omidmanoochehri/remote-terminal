#!/usr/bin/env bash
#
# Remote Terminal agent — Linux installer (Ubuntu 22.04/24.04, Debian, any
# systemd distribution). Installs the agent under /opt, runs it as a dedicated
# unprivileged user via systemd, enrols it with the relay and prints a pairing
# code for the phone.
#
#   sudo ./install-linux.sh --server wss://relay.example.com --enroll-token <TOKEN> [--name "Prod Server"]
#   sudo ./install-linux.sh --pair          # print a new pairing code
#   sudo ./install-linux.sh --status        # service + relay status
#   sudo ./install-linux.sh --uninstall     # remove service + program (keeps config/state unless --purge)
#
# Options:
#   --user <name>      run the agent (and every terminal) as this user
#                      (default: a system user "remote-terminal" is created)
#   --dir <path>       install directory (default /opt/remote-terminal-agent)
#   --no-start         install but do not start the service
#   --allow-root       run the agent (and every terminal) as root — full system
#                      access for anyone who pairs a phone; use deliberately
#   --purge            with --uninstall: also delete config and identity
#
set -euo pipefail

INSTALL_DIR=/opt/remote-terminal-agent
CONFIG_DIR=/etc/remote-terminal-agent
STATE_DIR=/var/lib/remote-terminal-agent
SERVICE=remote-terminal-agent
RUN_USER=remote-terminal
SERVER=""
ENROLL_TOKEN=""
NAME=""
ACTION=install
START=1
PURGE=0
ALLOW_ROOT=0

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --enroll-token|--token) ENROLL_TOKEN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --allow-root) ALLOW_ROOT=1; RUN_USER=root; shift ;;
    --purge) PURGE=1; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    --status) ACTION=status; shift ;;
    --pair) ACTION=pair; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then echo "Run with sudo (the installer creates a service user and a systemd unit)." >&2; exit 1; fi

NODE_BIN=""

# The service runs as an unprivileged user, so the interpreter must be one that
# user can execute: a per-user install (nvm under /root) is unusable even though
# it is first on root's PATH. Prefer a system-wide Node.js 18+.
node_usable() {
  local n="$1" v
  [[ -n "$n" && -x "$n" ]] || return 1
  if id -u "$RUN_USER" >/dev/null 2>&1; then
    v="$(sudo -u "$RUN_USER" "$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  else
    v="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  fi
  [[ -n "$v" && "$v" -ge 18 ]]
}

select_node() {
  local candidates=("$(command -v node || true)" /usr/local/bin/node /usr/bin/node)
  for n in "${candidates[@]}"; do
    if node_usable "$n"; then NODE_BIN="$n"; return 0; fi
  done
  local found="$(command -v node || true)"
  if [[ -n "$found" ]]; then
    echo "Node.js at $found cannot be used by the service user '$RUN_USER' (per-user installs such as nvm are not readable by other users, and Node.js 18+ is required)." >&2
    echo "Install Node.js 18+ system-wide, e.g.:  sudo apt install nodejs   (or https://nodejs.org)" >&2
  else
    echo "node not found on PATH. Install Node.js 18+ first (https://nodejs.org)." >&2
  fi
  exit 1
}

run_as_agent() { sudo -u "$RUN_USER" env CONFIG="$CONFIG_DIR/config.json" "$NODE_BIN" "$INSTALL_DIR/index.js" "$@"; }

# For status/pair/uninstall, use whatever user the installed service actually runs as.
if [[ "$ACTION" != "install" ]]; then
  UNIT="/etc/systemd/system/$SERVICE.service"
  if [[ -f "$UNIT" ]]; then
    INSTALLED_USER="$(sed -n 's/^User=//p' "$UNIT" | head -1)"
    [[ -n "$INSTALLED_USER" ]] && RUN_USER="$INSTALLED_USER"
  fi
  select_node
fi

case "$ACTION" in
  status)
    systemctl --no-pager --lines=5 status "$SERVICE" || true
    echo
    run_as_agent --status
    exit 0 ;;
  pair)
    run_as_agent --pair
    exit 0 ;;
  uninstall)
    systemctl disable --now "$SERVICE" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE.service"
    systemctl daemon-reload
    rm -rf "$INSTALL_DIR"
    if [[ $PURGE -eq 1 ]]; then rm -rf "$CONFIG_DIR" "$STATE_DIR"; echo "Removed program, config and identity."; else echo "Removed program and service. Config ($CONFIG_DIR) and identity ($STATE_DIR) kept; use --purge to delete them."; fi
    echo "Remember to remove the machine in the app (Machines → machine → Remove) so its token is revoked."
    exit 0 ;;
esac

# ------------------------------- install --------------------------------

if [[ ! -f "$CONFIG_DIR/config.json" && ( -z "$SERVER" || -z "$ENROLL_TOKEN" ) ]]; then
  echo "First install needs --server <wss://relay> and --enroll-token <token> (the relay's ENROLL_TOKEN)." >&2
  exit 2
fi

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  echo "Creating system user '$RUN_USER' (home: $STATE_DIR)"
  useradd --system --create-home --home-dir "$STATE_DIR" --shell /bin/bash "$RUN_USER"
fi
RUN_GROUP="$(id -gn "$RUN_USER")"
if [[ "$(id -u "$RUN_USER")" -eq 0 && $ALLOW_ROOT -ne 1 ]]; then
  echo "Refusing to install with root as the service user. Pass --allow-root if every remote terminal really should have full system access." >&2
  exit 1
fi
if [[ $ALLOW_ROOT -eq 1 ]]; then
  echo "WARNING: terminals will run as root — anyone who pairs a phone gets full system access."
fi
select_node
echo "Using Node.js $("$NODE_BIN" -v) at $NODE_BIN"

echo "Installing agent to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp "$SRC_DIR/index.js" "$SRC_DIR/package.json" "$INSTALL_DIR/"
[[ -f "$SRC_DIR/package-lock.json" ]] && cp "$SRC_DIR/package-lock.json" "$INSTALL_DIR/"
rm -rf "$INSTALL_DIR/lib"; cp -r "$SRC_DIR/lib" "$INSTALL_DIR/lib"
# Native modules (node-pty) are ABI-specific: install them with the interpreter
# the service will actually run, or the agent silently falls back to pipes.
NODE_DIR="$(dirname "$NODE_BIN")"
( cd "$INSTALL_DIR" && PATH="$NODE_DIR:$PATH" bash -c 'if [[ -f package-lock.json ]]; then npm ci --omit=dev --no-audit --no-fund --loglevel=error; else npm install --omit=dev --no-audit --no-fund --loglevel=error; fi' )
chown -R root:root "$INSTALL_DIR"
chmod -R a+rX "$INSTALL_DIR"

if ! sudo -u "$RUN_USER" "$NODE_BIN" -e "require('$INSTALL_DIR/node_modules/@homebridge/node-pty-prebuilt-multiarch')" 2>/dev/null; then
  echo "Rebuilding node-pty for $("$NODE_BIN" -v)..."
  ( cd "$INSTALL_DIR" && PATH="$NODE_DIR:$PATH" npm rebuild @homebridge/node-pty-prebuilt-multiarch --build-from-source --loglevel=error ) || true
  chmod -R a+rX "$INSTALL_DIR"
  if ! sudo -u "$RUN_USER" "$NODE_BIN" -e "require('$INSTALL_DIR/node_modules/@homebridge/node-pty-prebuilt-multiarch')" 2>/dev/null; then
    echo "WARNING: node-pty could not be loaded; terminals will use the pipe fallback (no resize, no full-screen programs)." >&2
    echo "         Install build tools (sudo apt install -y build-essential python3) and re-run this installer." >&2
  fi
fi

mkdir -p "$CONFIG_DIR" "$STATE_DIR"
chown "$RUN_USER:$RUN_GROUP" "$STATE_DIR"; chmod 700 "$STATE_DIR"
if [[ -n "$SERVER" ]]; then
  # Write config.json (readable by root and the service user only).
  "$NODE_BIN" - "$CONFIG_DIR/config.json" "$SERVER" "$ENROLL_TOKEN" "$NAME" "$STATE_DIR/state.json" "$ALLOW_ROOT" <<'EOF'
const fs = require('fs');
const [file, server, token, name, stateFile, allowRoot] = process.argv.slice(2);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
cfg.server = server;
if (token) cfg.enrollToken = token;
if (name) cfg.name = name;
cfg.stateFile = stateFile;
cfg.allowRoot = allowRoot === '1';
if (!cfg.logLevel) cfg.logLevel = 'info';
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o640 });
EOF
  chown "root:$RUN_GROUP" "$CONFIG_DIR/config.json"; chmod 640 "$CONFIG_DIR/config.json"
fi

sed -e "s|__USER__|$RUN_USER|g" -e "s|__GROUP__|$RUN_GROUP|g" -e "s|__CONFIG_DIR__|$CONFIG_DIR|g" \
    -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__NODE__|$NODE_BIN|g" \
    "$SRC_DIR/remote-terminal-agent.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

if [[ $START -eq 0 ]]; then echo "Installed. Start with: sudo systemctl start $SERVICE"; exit 0; fi
systemctl restart "$SERVICE"

echo -n "Waiting for the agent to enrol with the relay"
for _ in $(seq 1 30); do
  if [[ -s "$STATE_DIR/state.json" ]] && grep -q '"agentId": "a_' "$STATE_DIR/state.json"; then break; fi
  echo -n "."; sleep 1
done
echo
if ! grep -q '"agentId": "a_' "$STATE_DIR/state.json" 2>/dev/null; then
  echo "The agent has not enrolled yet. Check: journalctl -u $SERVICE -n 50" >&2
  exit 1
fi

echo
echo "Remote Terminal Agent"
run_as_agent --status | sed 's/^/  /'
echo
run_as_agent --pair
echo "Later: sudo $0 --pair   (new code)   |   journalctl -u $SERVICE -f   (logs)"
