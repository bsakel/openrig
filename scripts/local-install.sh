#!/bin/bash
# Local fork: build this checkout and install it as the global `rig`.
#
# Run inside WSL/Linux from a clone on the Linux filesystem (not /mnt/c):
# better-sqlite3 is native and must be built for the platform that runs it.
#
#   bash scripts/local-install.sh            # build + install the current checkout
#   bash scripts/local-install.sh --update   # first fetch the fork branch and rebase it on upstream main
#
# Pi seats run the native Pi TUI by default; OPENRIG_PI_TUI=0 in the shell
# that starts the daemon falls back to the RPC runner.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
cd "$REPO_ROOT"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" != "22" ] && [ "$NODE_MAJOR" != "24" ]; then
  echo "local-install: OpenRig needs Node 22 or 24 (found $(node -v 2>/dev/null || echo none), npm $(npm -v 2>/dev/null || echo none))" >&2
  exit 1
fi

if [ "${1:-}" = "--update" ]; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "local-install: commit or stash your changes before --update" >&2
    exit 1
  fi
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  # Clone layout: origin = your fork, upstream = mvschwarz/openrig.
  git pull --ff-only origin "$BRANCH"
  git fetch upstream
  git rebase upstream/main
  echo "local-install: $BRANCH rebased on upstream/main (push with: git push --force-with-lease origin $BRANCH)"
fi

echo "=== npm ci ==="
npm ci --no-audit --no-fund

echo "=== build package ==="
npm run build:package

echo "=== pack ==="
TARBALL="$(cd "$CLI_DIR" && npm pack 2>/dev/null | tail -1)"
[ -f "$CLI_DIR/$TARBALL" ] || { echo "local-install: npm pack did not produce a tarball" >&2; exit 1; }

echo "=== install ==="
if command -v rig >/dev/null 2>&1; then rig daemon stop || true; fi
npm install -g "$CLI_DIR/$TARBALL"
rm -f "$CLI_DIR/$TARBALL"

echo "=== start ==="
rig daemon start
rig --version || true
if [ "${OPENRIG_PI_TUI:-}" = "0" ]; then
  echo "local-install: note — OPENRIG_PI_TUI=0 in this shell, so Pi seats launch in RPC mode."
fi
