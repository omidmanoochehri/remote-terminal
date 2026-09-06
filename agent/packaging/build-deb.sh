#!/usr/bin/env bash
#
# Build remote-terminal-agent_<version>_<arch>.deb.
#
#   ./packaging/build-deb.sh                     # build for this machine
#   ./packaging/build-deb.sh --out ~/debs        # somewhere else
#   ./packaging/build-deb.sh --node /usr/bin/node
#
# Run it on Debian or Ubuntu; it needs dpkg-deb and npm.
#
# WHY THE PACKAGE IS ARCHITECTURE-SPECIFIC. node-pty is a native module, and
# the copy in node_modules is compiled for one CPU architecture and one Node
# ABI. A package built against a different major Node version than the target
# runs, but silently loses the PTY and falls back to pipes: no resize, no vim,
# no htop. So build with the Node the target will use — this script refuses to
# guess, and prints the version it used into the package description.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$HERE/.." && pwd)"
OUT_DIR="$AGENT_DIR/dist"
NODE_BIN="$(command -v node || true)"
ARCH=""
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --keep-build) KEEP=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v dpkg-deb >/dev/null || { echo "dpkg-deb not found — build this on Debian or Ubuntu." >&2; exit 1; }
command -v npm >/dev/null      || { echo "npm not found — install Node.js 18 or newer." >&2; exit 1; }
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "node not found; pass --node <path>." >&2; exit 1; }

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  echo "Node.js 18 or newer is required to build (found $("$NODE_BIN" -v))." >&2
  exit 1
fi
[[ -n "$ARCH" ]] || ARCH="$(dpkg --print-architecture)"
VERSION="$("$NODE_BIN" -p "require('$AGENT_DIR/package.json').version")"

PKG="remote-terminal-agent"
BUILD="$(mktemp -d)"
trap '[[ $KEEP -eq 1 ]] || rm -rf "$BUILD"' EXIT

LIB=usr/lib/$PKG
echo "Building $PKG $VERSION for $ARCH with $("$NODE_BIN" -v) ($NODE_BIN)"

# ---------------------------------------------------------------- program ---
install -d "$BUILD/$LIB"
cp "$AGENT_DIR/index.js" "$AGENT_DIR/package.json" "$BUILD/$LIB/"
cp "$AGENT_DIR/config.example.json" "$BUILD/$LIB/"
[[ -f "$AGENT_DIR/package-lock.json" ]] && cp "$AGENT_DIR/package-lock.json" "$BUILD/$LIB/"
cp -r "$AGENT_DIR/lib" "$BUILD/$LIB/lib"

# Production dependencies only, resolved with the Node the target will run.
echo "Installing dependencies…"
( cd "$BUILD/$LIB"
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev --no-audit --no-fund --loglevel=error
  else
    npm install --omit=dev --no-audit --no-fund --loglevel=error
  fi )

# A package that ships a broken native module is worse than one that fails to
# build, because the failure only shows up as a terminal that cannot resize.
if ! "$NODE_BIN" -e "require('$BUILD/$LIB/node_modules/@homebridge/node-pty-prebuilt-multiarch')" 2>/dev/null; then
  echo "error: node-pty does not load under $("$NODE_BIN" -v) after install." >&2
  echo "       Install build tools (build-essential python3) and try again." >&2
  exit 1
fi

# npm leaves absolute paths and build noise behind; a .deb should have neither.
find "$BUILD/$LIB/node_modules" -type d \
     \( -name test -o -name tests -o -name .github -o -name build -prune \) \
     -exec rm -rf {} + 2>/dev/null || true
find "$BUILD/$LIB/node_modules" -type f \
     \( -name '*.md' -o -name '*.ts' -o -name '.npmignore' -o -name '.eslintrc*' \) \
     -delete 2>/dev/null || true
rm -rf "$BUILD/$LIB/node_modules/.bin" "$BUILD/$LIB/node_modules/.package-lock.json"

# ------------------------------------------------------------- other files ---
install -D -m 0755 "$HERE/bin/$PKG"                     "$BUILD/usr/bin/$PKG"
install -D -m 0644 "$HERE/$PKG.service"                 "$BUILD/lib/systemd/system/$PKG.service"
install -D -m 0644 "$HERE/logrotate/$PKG"               "$BUILD/etc/logrotate.d/$PKG"
install -D -m 0644 "$HERE/default/$PKG"                 "$BUILD/etc/default/$PKG"
install -D -m 0644 "$HERE/debian/copyright"             "$BUILD/usr/share/doc/$PKG/copyright"
install -D -m 0644 "$HERE/man/$PKG.8"                   "$BUILD/usr/share/man/man8/$PKG.8"
gzip -9n "$BUILD/usr/share/man/man8/$PKG.8"

{
  echo "$PKG ($VERSION) stable; urgency=medium"
  echo
  echo "  * Remote Terminal agent $VERSION."
  echo
  echo " -- Cactus Software Group <cactus.team.dev@gmail.com>  $(date -R)"
} > "$BUILD/usr/share/doc/$PKG/changelog.Debian"
gzip -9n "$BUILD/usr/share/doc/$PKG/changelog.Debian"

# ------------------------------------------------------------------ control ---
INSTALLED_KB="$(du -sk "$BUILD" | cut -f1)"
install -d "$BUILD/DEBIAN"
cat > "$BUILD/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Section: admin
Priority: optional
Architecture: $ARCH
Maintainer: Cactus Software Group <cactus.team.dev@gmail.com>
Depends: nodejs (>= 18), adduser, systemd
Recommends: logrotate
Suggests: build-essential, python3
Installed-Size: $INSTALLED_KB
Homepage: https://github.com/cactus-software-group/remote-terminal
Description: real terminals on this machine, from your phone
 The Remote Terminal agent hosts PTY sessions on this machine and connects
 outward to a self-hosted relay, so a paired phone or desktop can open real
 terminals on it without this machine accepting any inbound connection.
 .
 It runs under systemd as an unprivileged user, and every terminal it opens
 runs as that user too. Sessions survive a dropped connection: the agent keeps
 a replay buffer per session and the phone catches up when it comes back.
 .
 Built against Node.js $NODE_MAJOR.x; the bundled node-pty is compiled for that
 ABI and this architecture.
EOF

for script in postinst prerm postrm; do
  # dpkg does not run #DEBHELPER#; this package has no debhelper to expand it.
  sed '/#DEBHELPER#/d' "$HERE/debian/$script" > "$BUILD/DEBIAN/$script"
  chmod 0755 "$BUILD/DEBIAN/$script"
done

# Files under /etc that dpkg should not overwrite when an admin has edited them.
# config.json is deliberately absent: it holds a credential, it is created by
# postinst, and a conffile prompt about a token would be the wrong question.
cat > "$BUILD/DEBIAN/conffiles" <<EOF
/etc/logrotate.d/$PKG
/etc/default/$PKG
EOF

# md5sums let `dpkg -V` and `debsums` report tampering.
( cd "$BUILD" && find . -type f ! -path './DEBIAN/*' -printf '%P\0' \
  | xargs -0 md5sum > DEBIAN/md5sums )

# --------------------------------------------------------------- assemble ---
find "$BUILD" -type d -exec chmod 0755 {} +
chmod 0755 "$BUILD/usr/bin/$PKG" "$BUILD/DEBIAN"/post* "$BUILD/DEBIAN/prerm"
find "$BUILD/$LIB" -type f -exec chmod 0644 {} +
find "$BUILD/$LIB" -name '*.node' -exec chmod 0755 {} +
[[ -x "$BUILD/$LIB/index.js" ]] || chmod 0644 "$BUILD/$LIB/index.js"

install -d "$OUT_DIR"
DEB="$OUT_DIR/${PKG}_${VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$BUILD" "$DEB" >/dev/null
echo "Built $DEB ($(du -h "$DEB" | cut -f1))"

if command -v lintian >/dev/null; then
  echo
  lintian --no-tag-display-limit "$DEB" || true
fi

cat <<EOF

Install it with:
  sudo apt install $DEB
  sudo remote-terminal-agent configure --server wss://relay.example.com --enroll-token <TOKEN>
  sudo systemctl start remote-terminal-agent
  sudo remote-terminal-agent pair
EOF
