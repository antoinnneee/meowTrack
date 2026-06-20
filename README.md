# Meowtrack — suivi local des bugs / features / tâches

Service de suivi (issue tracker minimaliste) pour le projet Meownopoly, avec :

- un **serveur MCP** (stdio) pour créer / lister / filtrer / clore des entrées depuis Claude Code ;
- un **dashboard web** local pour les gérer à la main ;
- des **références fichiers/dossiers** ancrées sur le **repo git cloné** (validées + contexte git capturé) ;
- la gestion de **plusieurs dépôts git** (multi-repos) : chaque entrée/nœud est scopé par repo.

La base est **locale par machine** (SQLite `meowtrack.db`, gitignorée) — chaque dev a sa propre liste. Le dossier `meowtrack/` lui-même est versionné dans le repo, mais pas son contenu de base.

## Multi-repos

meowtrack suit **plusieurs dépôts git distincts** via un **registre** (table `repos` : `slug`, `name`, `url`,
`local_path`, `default_branch`, `is_default`, `hidden_branches`). **Chaque entrée et chaque nœud appartient à un repo** ; les
codes (`BUG-1`, `NODE-2`…) sont **numérotés par repo** (unicité `(repo_id, ref)`, un compteur par repo). Les
listes, l'autocomplete `@`, les branches et le chat IA sont tous scopés sur le repo ciblé.

- **Cibler un repo** : paramètre `repo` (slug ou id) sur les outils MCP et `?repo=` sur les routes HTTP.
  Omis → le serveur retombe sur le repo **par défaut** (`is_default`). Côté MCP, `MEOWTRACK_DEFAULT_REPO`
  fixe un défaut local.
- **Ajouter / retirer un repo** : sélecteur + bouton **`＋ repo`** du dashboard, ou outils
  `meowtrack_repo_add` / `meowtrack_repo_remove` / `meowtrack_repo_update` (et `meowtrack_repos` pour lister).
- **Importer un dossier multi-repos** : bouton **`📁 dossier`** du dashboard (ou outil `meowtrack_repo_import`)
  → on donne un dossier, **tous les clones git qu'il contient** (le dossier lui-même + ses sous-dossiers
  directs, profondeur 1) sont détectés et enregistrés d'un coup, chacun par son `local_path` (sans `url` :
  lus tels quels, pas gérés par le service). Les clones déjà suivis sont ignorés ; slug dérivé du nom de
  dossier (suffixé en cas de collision).
- **Clones** : un repo avec `url` est cloné dans `meowtrack/.repos/<slug>/` (gitignoré). Un seul clone par
  repo sert toutes ses branches (lecture via `git ls-tree`, sans checkout).
- **Bootstrap / migration** : sur une base vierge, un repo par défaut est créé depuis `MEOWTRACK_REPO_URL` /
  `MEOWTRACK_REPO`. Une base de l'ancien schéma mono-repo est **migrée automatiquement** (toutes les données
  rattachées au repo par défaut, compteurs réconciliés, aucune perte).

Routes du registre : `GET /api/repos` (liste), `POST /api/repos` (ajouter + cloner),
`GET/PATCH/DELETE /api/repos/:slug` (détail / métadonnées / suppression cascade),
`POST /api/repos/:slug/update` (clone si absent, sinon `git pull`). Toutes les autres routes acceptent
`?repo=<slug|id>`.

## Installation

```bash
cd meowtrack
npm install
```

Dépendances : `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod` (cf. `package.json`).

## Dashboard web

```bash
npm run dashboard       # ou: node server.js
```

Ouvre http://127.0.0.1:7702 (port configurable via `MEOWTRACK_PORT`). Le serveur écoute **uniquement sur localhost** — c'est un outil dev.

Dans le formulaire de description, taper **`@`** déclenche un autocomplete des fichiers/dossiers suivis par git : la sélection insère le chemin dans le texte **et** l'associe automatiquement à l'entrée. Un champ dédié « Fichiers / dossiers associés » permet aussi d'ajouter des chemins à la main (avec le même autocomplete) et d'indiquer des plages de lignes via la syntaxe `chemin:120-145`.

## Serveur MCP

Deux façons d'exposer le **même** jeu d'outils (déclarés une seule fois dans `mcp-tools.js`) :

- **stdio (local)** — `meowtrack` → `node meowtrack/mcp.js`, qui relaie vers l'API HTTP du serveur (`MEOWTRACK_SERVER_URL`). Après `npm install`, redémarrer Claude Code.
- **HTTP distant (`type: http`)** — le serveur déployé expose directement l'endpoint MCP Streamable HTTP sur **`POST /mcp`** (même port que le dashboard, ex. `http://pattounecorp.ovh:7702/mcp`). Aucun process local à lancer :

  ```json
  {
    "mcpServers": {
      "meowtrack": {
        "type": "http",
        "url": "http://pattounecorp.ovh:7702/mcp",
        "headers": { "Authorization": "Bearer <MEOWTRACK_TOKEN>" }
      }
    }
  }
  ```

  L'endpoint `/mcp` est protégé par le **même** `MEOWTRACK_TOKEN` que `/api/*` (en-tête `Authorization: Bearer` ou `X-Meowtrack-Token` ; omettre `headers` si le serveur tourne sans token). Mode *stateless* : un serveur MCP éphémère par requête, les outils tapent l'API REST en loopback (seule source de vérité). Nécessite un redéploiement du serveur (`deploy.sh`) pour que `/mcp` soit disponible.

Tools exposés :

| Tool | Rôle |
| --- | --- |
| `meowtrack_create` | Créer un bug / feature / tâche / chore (avec `paths` + `@mentions`). |
| `meowtrack_list` | Lister / filtrer (type, statut, priorité, tag, chemin, plein-texte). |
| `meowtrack_get` | Détail complet d'une entrée (références + commentaires). |
| `meowtrack_update` | Modifier les champs (fournir `paths` remplace toutes les références). |
| `meowtrack_set_status` | Raccourci open / in_progress / done / wontfix. |
| `meowtrack_delete` | Supprimer une entrée (cascade). |
| `meowtrack_add_reference` | Ajouter une référence fichier/dossier (`chemin:120-145`). |
| `meowtrack_remove_reference` | Retirer une référence par id. |
| `meowtrack_comment` | Ajouter une note de suivi. |
| `meowtrack_search_paths` | Autocomplete des chemins du repo (feature `@`). |
| `meowtrack_stats` | Compteurs par statut/type/priorité + contexte git + registre des repos. |
| `meowtrack_refresh_paths` | Re-scan `git ls-files` après un pull / changement de branche. |
| `meowtrack_repos` | Lister les dépôts du registre. |
| `meowtrack_repo_add` | Ajouter (et cloner) un dépôt à suivre. |
| `meowtrack_repo_update` | `git pull` d'un dépôt (ou éditer ses métadonnées). |
| `meowtrack_repo_remove` | Retirer un dépôt et ses entrées/nœuds (cascade). |

Tous les outils d'entrées/nœuds/chemins acceptent un paramètre **`repo`** (slug ou id) ; omis, le repo par
défaut du serveur est utilisé (ou `MEOWTRACK_DEFAULT_REPO` côté MCP). Cf. [Multi-repos](#multi-repos).

Le MCP et le dashboard partagent la même base (WAL → lectures concurrentes). Les deux peuvent tourner simultanément.

## Modèle de données

- **issue** : `ref` (code lisible `BUG-1`, `FEAT-2`…), `type`, `title`, `description`, `status`, `priority`, `tags[]`, `branch`/`commit` (capturés à la création), timestamps.
- **reference** : `path` (repo-relatif, validé), `kind` (file/dir), `lineStart`/`lineEnd` optionnels, `existed` (le chemin existait-il au moment de la référence).
- **comment** : note de suivi horodatée.

### Références fichiers

Tout chemin est **normalisé en repo-relatif** et validé contre la racine résolue par `git rev-parse --show-toplevel` (anti path-traversal : un chemin hors repo est rejeté). Son existence et sa nature (fichier/dossier) sont capturées ; une référence dont le fichier a disparu est affichée « absent » dans le dashboard sans être supprimée.

## Configuration (variables d'env)

Lues via `dotenv` (fichier `.env`, cf. `.env.example`) ou directement dans l'environnement / l'unité systemd.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `MEOWTRACK_HOST` | `127.0.0.1` | Hôte d'écoute. `0.0.0.0` pour être joignable sur le réseau (déploiement). |
| `MEOWTRACK_PORT` | `7702` | Port HTTP du dashboard (choisir un port **libre**, pas 80). |
| `MEOWTRACK_TOKEN` | _(vide)_ | Si défini, `/api/*` exige `Authorization: Bearer <token>`. **Obligatoire en déploiement.** |
| `MEOWTRACK_REPO_URL` | _(vide)_ | **Bootstrap uniquement** : URL git du repo **par défaut** créé sur une base vierge. Les repos suivants s'ajoutent à chaud (dashboard / MCP) et sont clonés dans `meowtrack/.repos/<slug>/`. |
| `MEOWTRACK_REPO` | _(auto)_ | **Bootstrap uniquement** : chemin absolu d'un clone existant pour le repo par défaut. Auto-détecté via `git rev-parse` en dev in-repo. Avec `MEOWTRACK_REPO_URL`, destination du clone. |
| `MEOWTRACK_DEFAULT_REPO` | _(vide)_ | [Client MCP] Repo (slug/id) par défaut des outils MCP quand l'appel ne précise pas `repo`. |
| `MEOWTRACK_DB` | `meowtrack/meowtrack.db` | Chemin de la base SQLite. |
| `MEOWTRACK_CLAUDE_BIN` | `claude` | [Serveur] Binaire CLI Claude pour la feature « Améliorer la description » (IA). Doit être installé + authentifié sur le serveur. |

## Déploiement (serveur de dev, port dédié, sans nginx)

Même pattern que `chatServer`/`asset_server` : SCP + `npm install` + `systemctl restart`, mais le dashboard écoute **directement sur un port dédié** (pas de reverse-proxy, pas de port 80).

### 1. Première installation (one-shot sur le serveur)

```bash
# Sur la machine de dev : pousser les fichiers une première fois.
cd meowtrack
cp .deployEnv  # créé automatiquement au 1er run de deploy.sh, à remplir
./deploy.sh    # échouera au restart (service pas encore créé) — normal

# Sur le serveur, dans le dossier déployé :
cp .env.example .env     # éditer : MEOWTRACK_HOST=0.0.0.0, PORT libre, TOKEN, MEOWTRACK_REPO=<clone>
./install-service.sh     # crée + active le service systemd meownopoly-meowtrack
```

`install-service.sh` lit le `.env` via `EnvironmentFile`, installe les deps de prod, et `enable`/`start` le service. Aucune dépendance nginx/certbot.

### 2. Mises à jour (à chaque déploiement ultérieur)

```bash
cd meowtrack
./deploy.sh   # copie les fichiers + npm install + systemctl restart $SERVICE_NAME
```

`deploy.sh` lit `.deployEnv` (gitignored : `REMOTE_USER/HOST/DIR/PASSWORD`, `SERVICE_NAME=meownopoly-meowtrack`). **Ne copie pas** `node_modules/`, `meowtrack.db*`, `.env` ni `.deployEnv` — la base et la config de prod sont préservées.

### Accès au repo cloné

L'autocomplete `@` et la validation des références s'appuient sur `git ls-files` / `git ls-tree` exécuté à la racine du clone **de chaque repo**. Au démarrage, le service synchronise **tous** les repos du registre (clone si absent, sinon `git pull`). Deux options par repo :

- **Clone géré par le service** (recommandé) : donner une `url` au repo (bootstrap via `MEOWTRACK_REPO_URL`, ou ajout via dashboard/MCP). Cloné dans `meowtrack/.repos/<slug>/`, `git pull` au démarrage, et `POST /api/repos/<slug>/update` (bouton **⟳ Mettre à jour**) re-pulle à la demande.
- **Clone manuel** : donner un `local_path` (ou `MEOWTRACK_REPO` pour le repo par défaut) pointant un checkout présent sur le serveur, mis à jour à la main.

Sans clone accessible, l'autocomplete renvoie une liste vide mais la création/édition/suivi restent fonctionnels (les chemins sont alors stockés tels quels, `existed:false`).

### Suivi par branche

Chaque entrée est rattachée à une **branche git** (champ `branch`, sélectionnable dans la modale + filtrable via le sélecteur de la topbar) **au sein de son repo**. L'autocomplete `@` et la validation des références (`existed`) ciblent l'arbre de cette branche, lu via `git ls-tree <branche>` sur le **clone du repo** — pas besoin de checkout, toutes les branches connues du clone (locales + `origin/*`) sont servies. `GET /api/branches?repo=…` liste les branches ; `GET /api/paths?repo=…&branch=…` et `GET /api/issues?repo=…&branch=…` filtrent. Côté MCP : paramètres `repo` + `branch` sur `create`/`update`/`list`/`search_paths` + outils `meowtrack_branches` / `meowtrack_repos`.

**Masquer une branche.** Chaque repo garde une liste de branches masquées (colonne `hidden_branches`, tableau JSON, par dépôt). Une branche masquée disparaît de **tous les sélecteurs** (sélecteur de la topbar, modale, autocomplete `@` — soit `GET /api/branches`), mais le dépôt git n'est pas touché. Dans le **gestionnaire de repo** (sidebar), clic droit sur une branche locale/distante → **Masquer des sélecteurs** / **Afficher dans les sélecteurs** ; les branches masquées y restent listées, grisées et barrées, avec une pastille 🚫. Routes : `POST /api/git/branch/hide` et `POST /api/git/branch/unhide` (corps `{ name }`, scopé `?repo=`). La **branche de suivi** (`tracking`, cf. *Versionnement du suivi*) est **masquée par défaut** des sélecteurs et non démasquable depuis l'UI — elle n'a pas à polluer les sélecteurs de branches de code.

### Amélioration IA de la description

Le bouton **✨ Améliorer (IA)** de la modale (`POST /api/improve-description`) réécrit la description courante via `claude -p --model sonnet` (CLI headless, exécuté côté serveur, sans shell). Les `@chemin` sont préservés. Nécessite le CLI Claude installé + authentifié sur le serveur (`MEOWTRACK_CLAUDE_BIN`).

## Vibes — arbre de nœuds, graphe organique & chat IA streaming

Onglet **🌱 Vibes** du dashboard : un **arbre de NŒUDS récursif** (`nodes`, ref `NODE-1`…). Un seul
type de nœud — objectif = jalon = sous-jalon — chacun avec titre, statut, couleur, emoji, échéance et une
**progression** dérivée (moyenne récursive de ses enfants ; une feuille `done` = 100 %). Profondeur libre :
un jalon « sert de goal » et peut avoir ses propres sous-jalons.

### Liens de prérequis (un nœud sert à plusieurs parents)

En plus de la hiérarchie (un nœud = **un** parent structurel), des **liens de prérequis** relient des nœuds
**hors arbre** : « *A dépend de B* » (table `node_links`, `from_id` = dépendant, `to_id` = prérequis,
`kind = 'requires'`). Cas typique : la *brique réseau* est requise à la fois par le *chat* et le
*multijoueur* — elle vit à **un seul endroit** et les deux features pointent dessus. Ces liens sont
**purement relationnels** : ils n'affectent **ni le `path`/`depth` ni la progression** (pas de double
comptage) ; ils servent de **signal de blocage** (un nœud est « ⛔ bloqué » tant qu'un de ses prérequis
n'est pas `done`). Garde-fous : extrémités du **même repo** (intrinsèque, une base tracker par repo), pas
d'auto-lien, **anti-cycle** (refus si le prérequis atteint déjà le dépendant), cap par nœud, idempotent
(`UNIQUE(from_id,to_id,kind)`), **cascade** (supprimer un nœud purge ses liens entrants + sortants). Dans le
graphe : arête **pointillée orangée fléchée** (dépendant → prérequis), distincte des arêtes pleines de la
hiérarchie ; clic droit sur un nœud → « 🔒 Marquer un prérequis… », double-clic/clic droit sur l'arête pour
la retirer. En vue détail : sections **« Dépend de »** / **« Requis par »** + bouton **« ＋ Prérequis »**.

### Visualisation : graphe ↔ grille

Bascule (segment dans la barre) entre un **graphe organique** (SVG radial : nœuds colorés reliés par des
courbes, anneau de progression, pan/zoom à la molette/drag, **animation à la création** d'un nœud) et une
**grille** des objectifs racines. Le graphe est la vue par défaut. Clic sur un nœud → vue détail (arbre des
sous-nœuds + chat du nœud).

### Chat IA par nœud, scopé au sous-arbre

**Chaque nœud a son propre chat** avec Claude (modèle **sonnet / opus / haiku**). Le chat d'un nœud N peut
discuter ET **modifier N et tout son sous-arbre** (jamais en dehors) via des **actions structurées**
validées en base : `set_node_fields`, `add_node`, `update_node`, `delete_node`, `move_node`,
`reorder_children`. Chaque action est vérifiée `isInSubtree(N, cible)` (scope strict via le `path`
matérialisé) ; catalogue fermé, cap 20 actions/tour. Les modifications sont **auto-appliquées** sauf les
**actions destructives** (suppression de nœud, abandon) qui passent en **confirmation humaine**. L'auto-
suppression du nœud racine du chat est interdite (passer par le chat du parent).

### Chat « top level » (vue objectifs) — créer en discutant

En plus du chat par nœud, la **vue objectifs** (graphe/grille) embarque un **chat scopé sur tout le dépôt**
(dock en bas à droite, repliable). Idéal pour **brainstormer puis créer des objectifs RACINES tout en
discutant** : `add_node` **sans `parentId` crée un nouvel objectif racine** (avec `parentId`/`tmpKey` : un
sous-jalon). Le même catalogue d'actions s'applique (`add_node`, `update_node`, `set_node_fields`,
`delete_node`, `move_node`, `reorder_children`), mais la garde devient l'**appartenance au repo** (et non un
sous-arbre) : `applyForestActions` vérifie `node.repoId === repo` pour toute cible, cap 20 actions/tour et
quota global par repo. Mêmes garde-fous que le chat par nœud : auto-apply sauf **actions destructives** (→
confirmation humaine), streaming live, fail-closed sur réponse douteuse. Les messages sont stockés dans
`forest_messages` (scopés `repo_id`) et diffusés sur le canal SSE `forest:<repoId>` déjà existant.

### Chat en STREAMING (réflexion repliable)

L'appel passe par `claude -p --output-format stream-json` (`spawn` sans shell, kill + timeout). On voit
**défiler en direct** la réponse ; la **réflexion** (thinking) **et l'activité** (lectures de fichiers) vont
dans une **zone repliable, repliée par défaut**. À la fin, le message se finalise (réponse propre + actions
appliquées). Tous les participants voient le stream.

### Accès LECTURE au code (pour discuter du projet)

Le chat peut **lire le code source** du dépôt pour ancrer la discussion et proposer des jalons concrets
(`MEOWTRACK_AI_REPO_ACCESS=1`, défaut ; `0` pour verrouiller). C'est cadré : **lecture seule**
(`--allowedTools Read Glob Grep`), **aucune écriture/shell/réseau** (`--disallowedTools`, deny gagne),
**env sans le token**, et **fichiers sensibles refusés** (`--settings` deny sur `.env`, clés, `*.db`,
`.git`…). En déploiement, l'accès porte sur le **clone** (`MEOWTRACK_REPO`/`REPO_URL`) qui ne contient
aucun secret gitignoré par construction. L'« Améliorer la description » des bugs reste, lui, **sans aucun
outil** (réécriture de texte pure).

### Multi-utilisateurs temps réel (SSE)

**Messages et état (nœud + sous-arbre + progression) se synchronisent en direct** via **Server-Sent Events**
(100 % natif, aucune dépendance). Rooms `node:<id>` (chat + stream + état du nœud) + canal `forest:<repoId>`
(forêt d'un repo = graphe/grille ; un repo n'entend jamais les events d'un autre). Un changement profond remonte une sonnette `subtree:dirty` à la chaîne d'ancêtres → la vue
détail re-fetch son sous-arbre (auto-correcteur). Un ajout/retrait de prérequis émet `links:changed` (forêt
+ rooms des deux nœuds) → le graphe recharge ses liens et la vue détail rafraîchit « Dépend de / Requis par ».
Auth du flux par `?token=`. Un pseudo (`localStorage`) identifie chaque participant.

### Endpoints

| Méthode | Path | Rôle |
| --- | --- | --- |
| `GET` | `/api/nodes` | racines (grille) ; `?view=forest` = tout l'arbre (graphe) |
| `POST` | `/api/nodes` | créer un nœud (`parentId` pour un enfant, sinon racine) |
| `GET/PATCH/DELETE` | `/api/nodes/:ref` | détail (`?tree=true`/`?messages=true`) / éditer (`expectedVersion` → 409) / supprimer (cascade) |
| `POST` | `/api/nodes/:ref/move` | re-parenter (`newParentId`, anti-cycle) |
| `POST` | `/api/nodes/:ref/reorder` | réordonner les enfants |
| `GET` | `/api/nodes/links` | tous les liens de prérequis du repo (`[{id,fromId,toId,kind}]`) |
| `POST` | `/api/nodes/links` | créer un lien `{fromId,toId}` (`from` dépend de `to`, anti-cycle) |
| `DELETE` | `/api/nodes/links` | retirer un lien `{fromId,toId}` |
| `GET` | `/api/nodes/:ref/messages` | historique du chat du nœud |
| `POST` | `/api/nodes/:ref/chat` | message (lance le tour IA streaming, `202`, résultat via SSE) |
| `POST` | `/api/nodes/:ref/chat/confirm` | confirmer une proposition destructive |
| `GET` | `/api/nodes/:ref/stream` | flux SSE du nœud (chat + stream + état du sous-arbre) |
| `GET` | `/api/nodes/stream` | flux SSE de la forêt (graphe/grille **+ chat « top level »**) |
| `GET/DELETE` | `/api/forest/messages` | historique du chat « top level » du repo / le vider |
| `POST` | `/api/forest/chat` | message « top level » (tour IA streaming, `202`, résultat via SSE forêt) |
| `POST` | `/api/forest/chat/confirm` | confirmer une proposition destructive du chat « top level » |

La concurrence repose sur `nodes.version` (entier monotone bumpé sur le nœud **et** ses ancêtres à chaque
mutation) ; le front réconcilie par version. `node_messages.id` est l'ordre total du chat. La hiérarchie
utilise un `path` matérialisé (`/1/4/9/`) → subtree/ancestors/scope en SQL pur, sans CTE.

## Notes

- Pas de tests automatisés (cohérent avec le reste du repo).
- Le port `7702` suit la convention d'automation (`7700`/`7701`) ; en déploiement, choisir un port libre du serveur.
- L'API est protégée par `MEOWTRACK_TOKEN` quand il est défini ; le dashboard demande le token (stocké en `localStorage`) et réessaie sur `401`.
