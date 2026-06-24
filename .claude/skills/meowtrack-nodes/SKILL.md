---
name: meowtrack-nodes
description: Gérer l'arbre Vibes de meowtrack (objectifs / jalons / sous-jalons) d'un dépôt — créer, lister la forêt, lire, modifier, changer le statut, passer en attente d'info, éditer les notes markdown, déplacer (reparenter), réordonner, supprimer, et gérer les liens de prérequis (requires). Utiliser quand on demande de créer/organiser des objectifs ou jalons, de marquer un nœud done/waiting, ou de lier des prérequis. Couvre les outils MCP meowtrack_node_create/list/get/update/set_status/request_input/set_notes/move/reorder/delete/link_add/link_remove/links.
---

# meowtrack — nœuds Vibes (arbre d'objectifs)

Setup commun (base URL, auth `mt`, `?repo=`) : voir le skill **`meowtrack`**. Token de
dépôt → `?repo=` implicite ; sinon ajouter `?repo=<slug>`.

Vocabulaire : `status` = active|paused|waiting|done|abandoned · `kind` = normal|activation
(node d'activation = porte de prérequis manuelle) · `color` = accent|feature|task|bug|high.
Codes `NODE-1`… par dépôt. La **progression** est la moyenne récursive des enfants (calculée).

**Concurrence optimiste** : chaque nœud a un `version`. Un `PATCH` peut passer
`expectedVersion` ; s'il est périmé → `409 version_conflict` (relire le nœud puis réessayer).

## Outils MCP → routes HTTP

| Opération | Route |
|---|---|
| forêt à plat (graphe) | `GET /api/nodes?view=forest` |
| objectifs racines (grille) | `GET /api/nodes?status=&text=&limit=` |
| lire un nœud (+sous-arbre/messages) | `GET /api/nodes/:ref?tree=true&messages=false` |
| créer (racine ou enfant) | `POST /api/nodes { title, parentId?, description?, status?, kind?, color?, emoji? }` |
| modifier | `PATCH /api/nodes/:ref { title?, description?, status?, color?, emoji?, kind?, expectedVersion? }` |
| changer le statut | `PATCH /api/nodes/:ref { status }` |
| **request_input** (bloqué sur info user) | `PATCH /api/nodes/:ref { status:"waiting", pendingInfo:"ce qui manque (jamais un secret)" }` |
| éditer les notes markdown | `PATCH /api/nodes/:ref { notes }` |
| déplacer (reparenter) | `POST /api/nodes/:ref/move { newParentId, position? }` (`newParentId:null` → racine) |
| réordonner les enfants | `POST /api/nodes/:ref/reorder { order:[id,…] }` |
| supprimer (sous-arbre cascade) | `DELETE /api/nodes/:ref` |
| lister les liens de prérequis | `GET /api/nodes/links` |
| ajouter un prérequis | `POST /api/nodes/links { fromId, toId }` (from **dépend de** to) |
| retirer un prérequis | `DELETE /api/nodes/links { fromId, toId }` |

Les liens `requires` sont hors hiérarchie (n'affectent pas progression/profondeur) ; gardés
contre auto-lien, cycles et cap par nœud. Un node d'activation (`kind:"activation"`) bloque
tout nœud qui le `requires` tant qu'il n'est pas `done` (activé).

## Exemples

```bash
# Forêt compacte (ref, profondeur, statut, titre)
mt "$MT/api/nodes?view=forest" | jq -r '.[] | "\(.ref)\t\(.depth)\t[\(.status)]\t\(.title)"'

# Créer un objectif racine puis un sous-jalon
ROOT=$(mt -X POST -H 'Content-Type: application/json' -d '{"title":"Sortir la V2","emoji":"🎯"}' "$MT/api/nodes" | jq -r '.id')
mt -X POST -H 'Content-Type: application/json' -d "{\"title\":\"Refonte réseau\",\"parentId\":$ROOT}" "$MT/api/nodes" | jq '{ref,id}'

# Marquer un nœud atteint
mt -X PATCH -H 'Content-Type: application/json' -d '{"status":"done"}' "$MT/api/nodes/NODE-42"

# Le mettre en attente d'une info utilisateur (clé API…) — jamais la valeur du secret
mt -X PATCH -H 'Content-Type: application/json' \
   -d '{"status":"waiting","pendingInfo":"Clé API Stripe (test) requise pour câbler le paiement."}' "$MT/api/nodes/NODE-42"

# Lier : NODE-50 dépend de NODE-49 (prérequis). Utilise les IDS numériques.
mt -X POST -H 'Content-Type: application/json' -d '{"fromId":50,"toId":49}' "$MT/api/nodes/links" | jq '{fromId,toId}'
```

Ancrage code : `routes/nodes.js`, `db/nodes.js`.
