---
name: meowtrack-links
description: Rattacher ou détacher une entrée de suivi (issue) à un jalon Vibes (nœud) du même dépôt meowtrack — un lien VIVANT (le titre/statut/progression du nœud est relu, jamais copié). Utiliser quand on demande de lier une issue à un jalon/objectif, d'afficher les jalons d'une entrée, ou de détacher ce lien. Couvre les outils MCP meowtrack_issue_link_node / issue_unlink_node.
---

# meowtrack — liens issue ↔ jalon

Setup commun (base URL, auth `mt`, `?repo=`) : voir le skill **`meowtrack`**. Token de
dépôt → `?repo=` implicite ; sinon ajouter `?repo=<slug>`.

Une entrée de suivi peut référencer un ou plusieurs **jalons** (nœuds Vibes) du **même
dépôt**. C'est un lien **live** (table `issue_nodes`) : on lit toujours l'état courant du
nœud, rien n'est copié. Idempotent (lier deux fois = un seul lien) ; `ON DELETE CASCADE`
des deux côtés.

## Outils MCP → routes HTTP

| Opération | Route |
|---|---|
| lier un jalon à une entrée | `POST /api/issues/:ref/nodes { node }` (`node` = code `NODE-7` ou id ; `nodeRef` accepté aussi) |
| détacher un jalon | `DELETE /api/issues/:ref/nodes/:nodeId` (`:nodeId` = **id** numérique du nœud) |
| voir les jalons d'une entrée | `GET /api/issues/:ref` → champ `nodes` |
| voir les entrées d'un nœud | `GET /api/nodes/:ref` → champ `issues` |

## Exemples

```bash
# Lier le jalon NODE-7 à l'entrée BUG-12
mt -X POST -H 'Content-Type: application/json' -d '{"node":"NODE-7"}' "$MT/api/issues/BUG-12/nodes" | jq .

# Lister les jalons rattachés à une entrée
mt "$MT/api/issues/BUG-12" | jq -r '.nodes[]? | "\(.ref)\t[\(.status)]\t\(.progress)%\t\(.title)"'

# Détacher (par ID numérique du nœud)
NID=$(mt "$MT/api/nodes/NODE-7" | jq '.id')
mt -X DELETE "$MT/api/issues/BUG-12/nodes/$NID" | jq .

# Inversement : les entrées liées à un jalon
mt "$MT/api/nodes/NODE-7" | jq -r '.issues[]? | "\(.ref)\t[\(.status)]\t\(.title)"'
```

Ancrage code : pont `issue_nodes` (`db/issues.js`), routes `routes/issues.js`.
