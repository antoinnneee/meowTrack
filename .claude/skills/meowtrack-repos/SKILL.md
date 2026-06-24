---
name: meowtrack-repos
description: Gérer le registre des dépôts meowtrack (lister, ajouter par URL de clone, importer un dossier multi-dépôts, mettre à jour le clone, retirer un dépôt). Utiliser quand on demande de lister/ajouter/importer/supprimer un repo suivi par meowtrack, ou de mettre à jour (git pull) un clone. Couvre les outils MCP meowtrack_repos/repo_add/repo_import/repo_update/repo_remove.
---

# meowtrack — dépôts (registre)

Setup commun (base URL, auth, helper `mt`) : voir le skill **`meowtrack`**. Rappel minimal :

```bash
MT="${MEOWTRACK_SERVER_URL:-http://127.0.0.1:7702}"
TOKEN="$( (cat .meowtrack/token 2>/dev/null) | tr -d '[:space:]' )"; TOKEN="${TOKEN:-$MEOWTRACK_TOKEN}"
auth=(); [ -n "$TOKEN" ] && auth=(-H "Authorization: Bearer $TOKEN")
mt() { curl -fsS "${auth[@]}" "$@"; }
```

> ⚠️ **Admin requis.** Créer / importer / supprimer un dépôt sont des opérations
> **cross-repo réservées à l'admin** (token global `MEOWTRACK_TOKEN`). Un token de DÉPÔT
> ne voit que SON dépôt (liste filtrée) et ne peut ni en créer ni en supprimer (→ `403`).

## Outils MCP → routes HTTP

| Opération | Route |
|---|---|
| lister les dépôts | `GET /api/repos` |
| détail d'un dépôt (+ token) | `GET /api/repos/:idOrSlug` |
| ajouter (clone URL) | `POST /api/repos { url }` |
| importer un dossier multi-dépôts | `POST /api/repos/import { dir }` |
| mettre à jour le clone (fetch+pull) | `POST /api/repos/:idOrSlug/update` |
| modifier les métadonnées | `PATCH /api/repos/:idOrSlug { name?, url?, localPath?, defaultBranch?, hiddenBranches? }` |
| régénérer le token du dépôt | `POST /api/repos/:idOrSlug/token/rotate` |
| retirer (LOCAL : entrées + nœuds + clone géré) | `DELETE /api/repos/:idOrSlug` |
| résoudre un cwd → dépôt | `GET /api/repos/resolve?path=<cwd>` |

## Exemples

```bash
# Lister
mt "$MT/api/repos" | jq -r '.[] | "\(.id)\t\(.slug)\t\(.name)\t\(if .isDefault then "(défaut)" else "" end)"'

# Ajouter un dépôt à partir de son URL git (clone immédiat ; le slug est dérivé de l'URL)
mt -X POST -H 'Content-Type: application/json' \
   -d '{"url":"https://github.com/user/projet.git"}' "$MT/api/repos" | jq '.repo, .sync'

# Importer tous les clones git d'un dossier (profondeur 1, utilisés SUR PLACE via local_path)
mt -X POST -H 'Content-Type: application/json' \
   -d '{"dir":"/home/me/code"}' "$MT/api/repos/import" | jq '{found, added, skipped, errors}'

# Mettre à jour le clone d'un dépôt (git fetch + pull côté serveur)
mt -X POST "$MT/api/repos/meownopoly/update" | jq '{ok, branch, commit}'

# Régénérer le token d'un dépôt (invalide l'ancien → recopier dans .meowtrack/token)
mt -X POST "$MT/api/repos/meownopoly/token/rotate" | jq -r '.token'

# Retirer un dépôt (suppression LOCALE ; le dépôt distant n'est PAS touché ; le dernier
# dépôt ne peut pas être retiré)
mt -X DELETE "$MT/api/repos/ancien-projet" | jq '{deleted, clone}'
```

Ancrage code : `routes/repos.js`, registre `db/registry.js`.
