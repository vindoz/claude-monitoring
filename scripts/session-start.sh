#!/usr/bin/env sh
# Hook SessionStart : démarre le tableau de bord ccmon s'il ne tourne pas déjà,
# puis l'ouvre dans le navigateur. Ne bloque jamais le démarrage de la session
# (serveur détaché, ouverture du navigateur en tâche de fond, best-effort).
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PORT="${CCMON_PORT:-4757}"
URL="http://127.0.0.1:${PORT}/"

# Déjà en ligne ? → ne rien faire (pas de second serveur, pas de réouverture).
if command -v curl >/dev/null 2>&1 && curl -fs --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  exit 0
fi

# Résolution de Node (le PATH du hook n'inclut pas toujours nvm).
NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
[ -z "$NODE_BIN" ] && exit 0

# Démarrage du serveur, détaché de la session.
nohup "$NODE_BIN" "$DIR/../dist/cli.js" serve --port "$PORT" >/tmp/ccmon-serve.log 2>&1 &

# Ouverture du navigateur, après un court délai, sauf si désactivée (tests / serveur sans affichage).
if [ -z "$CCMON_NO_OPEN" ]; then
  if command -v xdg-open >/dev/null 2>&1; then
    ( sleep 1; xdg-open "$URL" >/dev/null 2>&1 ) &
  elif [ -n "$BROWSER" ]; then
    ( sleep 1; "$BROWSER" "$URL" >/dev/null 2>&1 ) &
  fi
fi

exit 0
