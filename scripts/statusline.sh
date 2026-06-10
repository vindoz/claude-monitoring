#!/usr/bin/env sh
# Relaie le JSON de statusline (reçu sur stdin) au binaire ccmon.
# Aucun accès à la base de données : lecture stdin uniquement, pour rester sous les 300 ms.
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$DIR/../dist/cli.js" statusline "$@"
