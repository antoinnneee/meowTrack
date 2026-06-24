---
name: meowtrack-issues
description: Gérer les entrées de suivi (issues) meowtrack d'un dépôt — créer, lister/filtrer, lire, modifier, changer le statut, réordonner, ajouter des références de fichiers et des commentaires, et lire branches / autocomplete de chemins / stats. Utiliser quand on demande de créer un bug/feature/tâche, mettre à jour une entrée, lister le suivi, ou ajouter une référence/commentaire. Couvre les outils MCP meowtrack_create/list/get/update/set_status/delete/reorder/add_reference/remove_reference/comment/search_paths/branches/refresh_paths/stats.
---

# meowtrack — suivi (issues)

Setup commun (base URL, auth `mt`, résolution `?repo=`) : voir le skill **`meowtrack`**.
Avec un token de dépôt, le dépôt est déjà épinglé → omettre `?repo=`. Sinon, ajouter
`?repo=<slug>` sur chaque route.

Vocabulaire : `type` = bug|feature|task|chore · `status` = open|in_progress|done|wontfix ·
`priority` = low|medium|high|critical. Les codes sont **par dépôt** (`BUG-1`, `FEAT-2`…).

## Outils MCP → routes HTTP

| Opération | Route |
|---|---|
| lister (filtres) | `GET /api/issues?type=&status=&priority=&branch=&tag=&path=&text=&includeClosed=&limit=` |
| créer | `POST /api/issues { type, title, description?, priority?, tags?, branch?, refs? }` |
| lire | `GET /api/issues/:ref` |
| modifier | `PATCH /api/issues/:ref { title?, description?, priority?, status?, tags?, branch? }` |
| changer le statut | `PATCH /api/issues/:ref { status }` |
| supprimer | `DELETE /api/issues/:ref` |
| réordonner (ordre manuel) | `POST /api/issues/reorder { order:[ref|id,…] }` |
| ajouter une référence fichier | `POST /api/issues/:ref/references { path }` |
| retirer une référence | `DELETE /api/references/:id` |
| commenter | `POST /api/issues/:ref/comments { body }` |
| autocomplete de chemins (@) | `GET /api/paths?q=&limit=&branch=` |
| re-scan de l'index des chemins | `POST /api/paths/refresh?branch=` |
| branches connues du clone | `GET /api/branches` |
| stats du dépôt | `GET /api/meta` (champs de stats inclus) |

`path` d'une référence peut porter une plage de lignes : `src/app.js:10-42`.

## Exemples

```bash
# Lister le suivi actif (open + in_progress), compact
mt "$MT/api/issues" | jq -r '.[] | "\(.ref)\t[\(.status)]\t\(.title)"'

# Créer un bug avec une référence fichier
mt -X POST -H 'Content-Type: application/json' -d '{
  "type":"bug","title":"Crash au démarrage","priority":"high",
  "description":"Stacktrace ESM…","refs":[{"path":"server.js:58-97"}]
}' "$MT/api/issues" | jq '{ref, status}'

# Passer une entrée « en cours »
mt -X PATCH -H 'Content-Type: application/json' -d '{"status":"in_progress"}' "$MT/api/issues/BUG-12"

# Ajouter une référence et un commentaire
mt -X POST -H 'Content-Type: application/json' -d '{"path":"db/issues.js:120-140"}' "$MT/api/issues/BUG-12/references"
mt -X POST -H 'Content-Type: application/json' -d '{"body":"Reproduit sur main @ a015907."}' "$MT/api/issues/BUG-12/comments"

# Réordonner (les refs listés passent devant, le reste garde son ordre)
mt -X POST -H 'Content-Type: application/json' -d '{"order":["FEAT-3","BUG-12"]}' "$MT/api/issues/reorder" | jq '.ok'

# Autocomplete @ : chemins du clone contenant "issues"
mt "$MT/api/paths?q=issues&limit=10" | jq -r '.[].path'
```

Ancrage code : `routes/issues.js`, `db/issues.js` ; chemins/branches/stats : `routes/repos.js`, `repos.js`.
