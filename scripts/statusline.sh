#!/usr/bin/env sh
# Relaie le JSON de statusline (reçu sur stdin) au binaire ccmon.
# Aucun accès à la base de données : lecture stdin uniquement, pour rester sous les 300 ms.
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Résolution de Node : PATH d'abord, puis nvm (le PATH n'inclut pas toujours nvm
# quand Claude Code lance la statusline), puis emplacements système courants.
NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
[ -z "$NODE_BIN" ] && { echo "node introuvable"; exit 0; }

exec "$NODE_BIN" "$DIR/../dist/cli.js" statusline "$@"
