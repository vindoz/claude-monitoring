---
name: sessions
description: Liste les sessions Claude Code et leurs coûts agrégés (par projet, session, modèle ou jour)
allowed-tools:
  - Bash
---

# /sessions — Sessions et coûts Claude Code

Quand l'utilisateur invoque `/sessions`, exécute l'outil de monitoring `ccmon` via Bash et
présente le résultat sous forme de tableau lisible.

## Comportement par défaut

Liste les sessions récentes (le `--json` facilite la mise en forme ; le bilan d'ingestion
s'affiche sur stderr et ne fait pas partie du JSON) :

```
__CCMON_BIN__ sessions --json --limit 30
```

## Variations selon la demande

- « coût par projet » → `__CCMON_BIN__ summary --by project --json`
- « coût par modèle » → `__CCMON_BIN__ summary --by model --json`
- « coût par jour » / évolution → `__CCMON_BIN__ summary --by day --json`
- restreindre à un projet → ajouter `--project <slug>`
- restreindre une période → ajouter `--since YYYY-MM-DD` et/ou `--until YYYY-MM-DD`

## Présentation

Présente les montants en dollars et les volumes de tokens de façon compacte (k / M).
Mets en avant le coût total. Si le champ `unknownModels` du JSON n'est pas vide, signale que
certains modèles ne sont pas tarifés (coût compté à zéro).
