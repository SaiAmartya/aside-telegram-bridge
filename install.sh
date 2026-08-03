#!/bin/bash
# aside-telegram-bridge one-line installer
#   curl -fsSL https://raw.githubusercontent.com/SaiAmartya/aside-telegram-bridge/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/SaiAmartya/aside-telegram-bridge"
DEST="${ASIDE_BRIDGE_DIR:-$HOME/aside-telegram-bridge}"

if [ "$(uname)" != "Darwin" ]; then
  echo "✗ macOS only for now (the services install via launchd)." >&2
  exit 1
fi
command -v git >/dev/null || { echo "✗ git is required (xcode-select --install)"; exit 1; }
command -v python3 >/dev/null || { echo "✗ python3 is required"; exit 1; }

# The Mini App is part of the default install, so check its prerequisite
# here rather than letting the user get most of the way through and then
# hit it. Not fatal: the chat bridge alone is still worth installing.
if command -v node >/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
    echo "! Node ${NODE_MAJOR} found, but the Mini App needs 20+."
    echo "  The chat bridge will still install. Upgrade Node, then run:"
    echo "    python3 \"$DEST/miniapp/setup-miniapp.py\""
  fi
else
  echo "! Node 20+ not found -- the Mini App needs it (https://nodejs.org)."
  echo "  The chat bridge will still install. After installing Node, run:"
  echo "    python3 \"$DEST/miniapp/setup-miniapp.py\""
fi

if [ -d "$DEST/.git" ]; then
  echo "→ Existing install found at $DEST, updating..."
  git -C "$DEST" pull --ff-only || echo "! couldn't fast-forward (local edits?), continuing with current copy"
else
  echo "→ Cloning into $DEST..."
  git clone --depth 1 "$REPO" "$DEST"
fi

cd "$DEST"
exec python3 setup.py < /dev/tty
