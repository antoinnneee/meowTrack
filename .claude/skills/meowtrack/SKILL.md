---
name: meowtrack
description: Fondation/transport pour parler au tracker meowtrack local via son API HTTP (au lieu de charger les ~43 outils MCP). Pose la base URL, l'auth (.meowtrack/token), la résolution du dépôt depuis le cwd et le format de sortie. Invoquée par les skills meowtrack-* (repos, issues, nodes, links, orchestrate) ou quand on demande comment appeler l'API meowtrack en curl.
---

# meowtrack — fondation (transport HTTP)

Meowtrack expose **deux portes** sur la même base de données : un serveur **MCP** (stdio)
et une **API HTTP** (dashboard). Ces skills attaquent **l'API HTTP `/api/*` en direct**
(curl) — aucun schéma d'outil MCP n'est rechargé (c'est tout l'intérêt vs les ~43 outils
MCP chargés à chaque session). Le serveur reste la **seule source de vérité**.

Ce skill est la **fondation** : les skills `meowtrack-repos`, `meowtrack-issues`,
`meowtrack-nodes`, `meowtrack-links` et `meowtrack-orchestrate` réutilisent les
conventions ci-dessous (base URL, auth, résolution du dépôt). Ne pas redupliquer cette
logique : s'y référer.

## Base URL

- Par défaut **`http://127.0.0.1:7702`** (localhost only — cf. `MEOWTRACK_HOST`/`MEOWTRACK_PORT`).
- En déploiement, remplacer par l'URL du serveur (ex. `http://monserveur:7702`) ; on peut
  la lire depuis `MEOWTRACK_SERVER_URL` si elle est définie.

## Auth (NODE-372 — un token par dépôt)

Deux niveaux de credential :

- **Token PAR dépôt** — un secret propre à chaque dépôt, déposé dans **`.meowtrack/token`**
  à la racine du clone (gitignoré). Il **scope l'accès à CE seul dépôt côté serveur** :
  c'est le credential normal des skills/MCP. Le serveur épingle automatiquement le `repo`
  du token — inutile (et rejeté si divergent) de passer un autre `?repo=`.
- **Token global `MEOWTRACK_TOKEN`** — accès **admin** cross-repo (dashboard). Repli si
  aucun fichier `.meowtrack/token` n'est présent.

L'en-tête est `Authorization: Bearer <token>` sur **chaque** appel `/api/*` (omettre si le
serveur tourne sans token, en local). Si `.meowtrack/token` est absent (serveur distant),
copier le token du dépôt depuis le dashboard (bouton **🔑 token**) dans ce fichier.

## Setup (snippet réutilisable)

À placer en tête de toute séquence d'appels (bash) :

```bash
MT="${MEOWTRACK_SERVER_URL:-http://127.0.0.1:7702}"
# Token de dépôt (.meowtrack/token, en remontant comme un .git) sinon token global.
TOKEN="$( (cat .meowtrack/token 2>/dev/null || cat ../.meowtrack/token 2>/dev/null) | tr -d '[:space:]' )"
TOKEN="${TOKEN:-$MEOWTRACK_TOKEN}"
auth=(); [ -n "$TOKEN" ] && auth=(-H "Authorization: Bearer $TOKEN")
mt() { curl -fsS "${auth[@]}" "$@"; }   # helper : mt <méthode/url…>
```

Ensuite : `mt "$MT/api/..."` (GET) ou `mt -X POST -H 'Content-Type: application/json' -d '{...}' "$MT/api/..."`.

## Résolution du dépôt (`?repo=`)

Chaque entrée / nœud appartient à **un dépôt**. Les routes scopées prennent `?repo=<slug|id>` ;
omis → dépôt `is_default` du serveur.

- **Avec un token de dépôt** : le serveur force déjà le bon dépôt → **ne rien passer**
  (un `?repo=` divergent est rejeté en 403).
- **Avec le token global** (ou pour cibler un autre dépôt) : résoudre le dépôt du cwd
  comme le verrou mono-repo MCP (NODE-301), puis passer `?repo=` :

```bash
REPO="$(mt "$MT/api/repos/resolve?path=$PWD" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')"
# puis : mt "$MT/api/nodes?repo=$REPO"   (REPO vide → dépôt par défaut)
```

## Format de sortie & pagination

- Réponses **JSON** (passer dans `jq` pour lire/projeter).
- Les grosses listes (issues, forêt de nœuds) se paginent **côté client** : la plupart des
  routes acceptent `?limit=` ; trancher avec `jq` (`.[range]`) ou `offset` quand la route le
  propose (`/api/nodes/runs`, …). Ne pas tout charger si on ne lit que les premiers éléments.

## Erreurs

- `401 unauthorized` → token manquant/incorrect (vérifier `.meowtrack/token` / `MEOWTRACK_TOKEN`).
- `403 forbidden_repo_scope` → un token de dépôt tente une route d'un AUTRE dépôt ou une
  route admin (créer/supprimer/importer un dépôt). Utiliser le token global pour l'admin.
- `404 not_found` → ref inconnu **dans ce dépôt** (vérifier le `?repo=`).
- `409` → conflit (ex. `version_conflict` sur PATCH nœud avec `expectedVersion` périmé ;
  `ai_busy` ; `lease_lost`).

## Catalogue des skills meowtrack

| Skill | Domaine |
|---|---|
| `meowtrack-repos` | registre des dépôts (lister/ajouter/importer/mettre à jour/retirer) |
| `meowtrack-issues` | entrées de suivi : CRUD, statut, ordre, références, commentaires, branches, chemins, stats |
| `meowtrack-nodes` | arbre Vibes (objectifs/jalons) : CRUD, statut, notes, déplacement, ordre, liens de prérequis |
| `meowtrack-links` | ponts issue ↔ jalon (lier/délier) |
| `meowtrack-orchestrate` | boucle agent : réclamer/peek/démarrer/clôturer un nœud + cycle de vie |
