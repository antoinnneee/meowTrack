# Meowtrack — suivi local des bugs / features / tâches

Service de suivi (issue tracker minimaliste) pour le projet Meownopoly, avec :

- un **serveur MCP** (stdio) pour créer / lister / filtrer / clore des entrées depuis Claude Code ;
- un **dashboard web** local pour les gérer à la main ;
- des **références fichiers/dossiers** ancrées sur le **repo git cloné** (validées + contexte git capturé) ;
- la gestion de **plusieurs dépôts git** (multi-repos) : chaque entrée/nœud est scopé par repo ;
- un onglet **Vibes** : arbre de jalons/objectifs avec graphe organique et **chat IA streaming** par nœud ;
- un **gestionnaire git** complet (staging par hunk, commit/amend, branches, merge/rebase, stash, GitHub) avec rafraîchissement temps réel.

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
| `meowtrack_reorder` | Définir l'ordre **manuel** des entrées (`order` = codes/ids ; prime sur le tri statut/priorité). |
| `meowtrack_add_reference` | Ajouter une référence fichier/dossier (`chemin:120-145`). |
| `meowtrack_remove_reference` | Retirer une référence par id. |
| `meowtrack_comment` | Ajouter une note de suivi. |
| `meowtrack_search_paths` | Autocomplete des chemins du repo (feature `@`). |
| `meowtrack_stats` | Compteurs par statut/type/priorité + contexte git + registre des repos. |
| `meowtrack_refresh_paths` | Re-scan `git ls-files` après un pull / changement de branche. |
| `meowtrack_repos` | Lister les dépôts du registre. |
| `meowtrack_repo_add` | Ajouter (et cloner) un dépôt à suivre. |
| `meowtrack_repo_import` | Importer tous les clones git d'un dossier (profondeur 1) d'un coup. |
| `meowtrack_repo_update` | `git pull` d'un dépôt (ou éditer ses métadonnées). |
| `meowtrack_repo_remove` | Retirer un dépôt et ses entrées/nœuds (cascade). |
| `meowtrack_branches` | Lister les branches d'un repo (hors branches masquées). |
| `meowtrack_node_list` / `_get` | Lister l'arbre des nœuds (Vibes) / détail d'un nœud (+ `requires`/`requiredBy`). |
| `meowtrack_node_create` / `_update` / `_delete` | Créer / modifier / supprimer un nœud (jalon). `kind:'activation'` crée un **node d'activation** (porte de prérequis manuelle). |
| `meowtrack_node_set_status` / `_set_notes` | Raccourcis statut (`active`/`paused`/`waiting`/`done`/`abandoned`) / notes d'un nœud. |
| `meowtrack_node_request_input` | Mettre un nœud **en attente d'info utilisateur** (`status='waiting'` + description du manque) : clé API, config, décision attendue avant implémentation. Sans secret dans le texte. |
| `meowtrack_node_move` / `_reorder` | Re-parenter un nœud (anti-cycle) / réordonner ses enfants. |
| `meowtrack_node_link_add` / `_remove` / `meowtrack_node_links` | Gérer les liens de prérequis (`from` dépend de `to`) / les lister. |

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
| `MEOWTRACK_TOKEN` | _(vide)_ | Si défini, `/api/*` **et `/mcp`** exigent `Authorization: Bearer <token>`. **Obligatoire en déploiement.** |
| `MEOWTRACK_REPO_URL` | _(vide)_ | **Bootstrap uniquement** : URL git du repo **par défaut** créé sur une base vierge. Les repos suivants s'ajoutent à chaud (dashboard / MCP) et sont clonés dans `meowtrack/.repos/<slug>/`. |
| `MEOWTRACK_REPO` | _(auto)_ | **Bootstrap uniquement** : chemin absolu d'un clone existant pour le repo par défaut. Auto-détecté via `git rev-parse` en dev in-repo. Avec `MEOWTRACK_REPO_URL`, destination du clone. |
| `MEOWTRACK_DEFAULT_REPO` | _(vide)_ | [Client MCP] Repo (slug/id) par défaut des outils MCP quand l'appel ne précise pas `repo`. |
| `MEOWTRACK_DB` | `meowtrack/meowtrack.db` | Chemin de la base SQLite. |
| `MEOWTRACK_CLAUDE_BIN` | `claude` | [Serveur] Binaire CLI Claude pour les features IA (« Améliorer la description », chat des nœuds, message de commit suggéré). Doit être installé + authentifié sur le serveur. |
| `MEOWTRACK_AI_REPO_ACCESS` | `1` | [Serveur] Accès **lecture seule** du chat IA au code source du clone (`Read Glob Grep`, sandboxé). `0` pour verrouiller. |
| `MEOWTRACK_GITHUB_CLIENT_ID` | _(vide)_ | [Serveur] Client ID OAuth GitHub pour l'auth **device flow** du gestionnaire git (sinon saisissable dans l'UI). |
| `MEOWTRACK_TRACKING_GIT` | `0` | [Serveur] `1` = versionner chaque `tracker.db` dans une branche `tracking` dédiée (worktree par repo). Cf. [Versionnement du suivi](#versionnement-du-suivi-tracking-git). |
| `MEOWTRACK_TRACKING_PUSH` | `0` | `1` = pousser la branche `tracking` vers le remote (sync inter-machines). |
| `MEOWTRACK_TRACKING_BRANCH` | `tracking` | Nom de la branche orpheline de suivi. |
| `MEOWTRACK_TRACKING_REMOTE` | `origin` | Remote vers lequel pousser la branche de suivi. |
| `MEOWTRACK_TRACKING_INTERVAL_MS` | `5000` | Cadence (débounce) du committer périodique du suivi. |
| `MEOWTRACK_TRACKING_NAME` / `_EMAIL` | `meowtrack` / `meowtrack@localhost` | Identité de commit dédiée au suivi (n'altère pas ta config git). |

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

**Masquer une branche.** Chaque repo garde une liste de branches masquées (colonne `hidden_branches`, tableau JSON, par dépôt). Une branche masquée disparaît de **tous les sélecteurs** (sélecteur de la topbar, modale, autocomplete `@` — soit `GET /api/branches`), mais le dépôt git n'est pas touché. Dans le **gestionnaire de repo** (sidebar), clic droit sur une branche locale/distante → **Masquer des sélecteurs** / **Afficher dans les sélecteurs** ; les branches masquées y restent listées, grisées et barrées, avec une pastille 🚫. Routes : `POST /api/git/branch/hide` et `POST /api/git/branch/unhide` (corps `{ name }`, scopé `?repo=`). La **branche de suivi** (`tracking`, cf. [Versionnement du suivi](#versionnement-du-suivi-tracking-git)) est **masquée par défaut** des sélecteurs et non démasquable depuis l'UI — elle n'a pas à polluer les sélecteurs de branches de code.

### Explorateur de fichiers (vue Repo)

Le bouton **📂 Fichiers** de la barre d'outils de l'onglet **🔀 Repo** ouvre une modale d'exploration des fichiers du dépôt : arborescence repliable à gauche (avec filtre), panneau de contenu à droite. Le panneau s'adapte au type de fichier :

- **Code / texte** : coloration syntaxique (highlight.js vendorisé dans `dashboard/`, hors-ligne) + numéros de ligne.
- **Markdown** : bouton **👁 Aperçu** pour basculer entre la source colorisée et le **rendu markdown** (réutilise le rendu anti-XSS des notes Vibes).
- **Média** (image, vidéo, son — png/jpg/gif/webp/svg…, mp4/webm/mov…, mp3/wav/ogg…) : **lecteur compatible** (`<img>` / `<video controls>` / `<audio controls>`), servi par un endpoint d'octets bruts.
- **Édition** : bouton **✎ Éditer** → éditeur **avec coloration syntaxique conservée** (textarea transparent superposé au rendu colorisé) ; **💾 Enregistrer** écrit le fichier **dans le working tree** (jamais un blob historique). Un point ● signale les modifications non enregistrées.
- **⛶ Plein écran** : bascule la modale en plein écran.

Endpoints, scopés `?repo=` :

- `GET /api/git/tree?branch=…` — arbre complet `{ files[], dirs[], branch, commit }` (branche omise → working tree via `git ls-files` ; branche fournie → arbre `git ls-tree` sans checkout). Non verrouillé.
- `GET /api/git/file?path=…&branch=…` — contenu texte `{ ok, path, branch, ref, size, content }` (borné 2 Mo, refus du binaire ; branche omise → working tree lu sur disque, sinon `git show <ref>:<chemin>` préférant `origin/<branch>`). Non verrouillé.
- `GET /api/git/raw?path=…&branch=…&token=…` — **octets bruts** du fichier avec son type MIME (déduit de l'extension), pour les lecteurs média ; auth par `?token=` car `<img>/<video>` ne portent pas d'en-tête. Non verrouillé.
- `PUT /api/git/file` (corps `{ path, content }`) — écrit le fichier **dans le working tree** (working tree uniquement, pas de branche). **Verrouillé par dépôt** (`withGitLock`) et diffuse `git:changed`. Limite pratique ~1 Mo (corps JSON borné par `readBody`).

Gardes communes à toutes ces routes : `normalizePath` (anti path-traversal, rejet du préfixe `:`), `isValidRef` (anti option-injection), `GIT_LITERAL_PATHSPECS` ; l'écriture refuse en plus `.git/` et tout chemin existant qui est un dossier.

### Amélioration IA de la description

Le bouton **✨ Améliorer (IA)** de la modale (`POST /api/improve-description`) réécrit la description courante via `claude -p --model sonnet` (CLI headless, exécuté côté serveur, sans shell). Les `@chemin` sont préservés. Nécessite le CLI Claude installé + authentifié sur le serveur (`MEOWTRACK_CLAUDE_BIN`).

### Jalons liés à une entrée

Une entrée de suivi peut **référencer un ou plusieurs jalons** (nœuds Vibes) de **son repo** — un lien
**vivant** : on relit toujours l'état courant du nœud (titre, statut, progression), rien n'est copié. En vue
détail, la section **« Jalons liés »** liste les jalons rattachés (clic → ouvre le nœud dans l'onglet Vibes) et
un sélecteur **« ➕ Importer un jalon… »** permet d'en ajouter ; un badge **🎯 N** apparaît sur la carte dans la
liste. Stocké dans la table `issue_nodes` (`issue_id`, `node_id`, `UNIQUE`/`PRIMARY KEY` → ajout idempotent,
`ON DELETE CASCADE` des deux côtés). Les deux extrémités sont du **même repo** par construction (une base
tracker par repo). Routes : `POST /api/issues/:ref/nodes` (`{ nodeRef }`, code `NODE-1` ou id) pour lier,
`DELETE /api/issues/:ref/nodes/:nodeId` pour détacher ; `GET /api/issues/:ref` renvoie le tableau `nodes`.

**Sens inverse (créer un suivi depuis un jalon).** Le détail d'un jalon (onglet Vibes) affiche une section
**« 🐞 Suivis liés »** listant les entrées rattachées (clic → ouvre l'entrée dans Suivi) avec un bouton
**« ➕ Suivi »** : il ouvre la modale de création d'entrée **pré-remplie** (titre = titre du jalon, type
`task`), et à l'enregistrement l'entrée est **automatiquement liée** au jalon puis affichée dans la vue Suivi.
Côté données, `GET /api/nodes/:ref` renvoie désormais aussi un tableau `issues` (résumé des entrées liées :
`ref`, `title`, `type`, `status`, `priority`).

## Gestionnaire git (working tree, branches, historique)

Le **gestionnaire de repo** (sidebar du dashboard) est un client git complet, **scopé sur le clone du repo
sélectionné**, branché sur l'API `/api/git/*`. Toutes les opérations s'exécutent **sans shell** (`execFile`,
validation stricte des refs/chemins). Côté serveur, **les lectures ne sont pas verrouillées ; chaque
opération MUTANTE passe par un verrou par dépôt** (une seule écriture git en vol — une 2ᵉ renvoie
`409 git_busy`).

- **Working tree & staging** : `status` (fichiers modifiés/staged/untracked, état d'un merge/rebase en cours),
  `stage` / `unstage` / `discard`, et **staging par *hunk*** via `apply-patch` (patch unifié appliqué
  `--cached` ou `--reverse`). `diff` d'un fichier (working / staged / untracked) et `diff-refs` entre deux refs.
- **Commits** : `commit` (avec **amend**), message de commit **suggéré par l'IA** (`POST /api/git/commit-message`),
  `reflog`, détail d'un commit, `blame` d'un fichier.
- **Branches** : créer / renommer / supprimer (local + distante), `checkout` (DWIM d'un `origin/<name>`),
  `checkout` d'un commit (detached), **masquer/afficher** des sélecteurs (`hidden_branches`, cf.
  [Suivi par branche](#suivi-par-branche)).
- **Intégration & réécriture** : `merge`, `rebase`, `cherry-pick`, `revert`, `reset` (soft/mixed/hard).
  Sur **conflit**, l'état de l'opération en cours est détecté (`operationState`) et l'UI propose
  **continuer** (`/api/git/continue`) ou **abandonner** (`/api/git/abort`).
- **Remotes & échanges** : `fetch`, `pull`, `push` (avec `-u`), gestion des `remote` (ajout/suppression),
  `tag` (créer/supprimer).
- **Stash** : `save` (avec untracked), `pop`, `apply`, `drop`, `show`, liste.

**Rafraîchissement temps réel.** La vue git s'abonne au canal SSE `git:<repoId>` (`GET /api/git/stream`) :
le serveur y diffuse `git:changed` **après chaque mutation** *et* sur **changement de fichier détecté** par un
**watcher fs paresseux** (`git-watch.js` — `fs.watch` récursif, actif uniquement tant qu'un client est branché,
débounce 600 ms, ignore le bruit interne de `.git` + `node_modules`). Résultat : la vue se met à jour sans
bouton, même quand les fichiers bougent **hors du dashboard** (édition dans l'IDE), et entre plusieurs onglets.
Tout est best-effort : si `fs.watch` échoue, on retombe sur les diffusions post-mutation + le bouton de
rafraîchissement.

### Authentification GitHub & identifiants

Pour `push`/`pull` sur un dépôt privé, le gestionnaire propose une connexion **GitHub via *device flow* OAuth**
(`POST /api/git/github/device/start` → code à saisir sur github.com → `…/device/poll` jusqu'à obtention du
token), avec un **client ID** configurable (`MEOWTRACK_GITHUB_CLIENT_ID` ou saisi dans l'UI) et la prise en
charge d'**hôtes personnalisés** (Gitea / GitLab self-hosted). Le token obtenu est rangé dans le **credential
helper git** du clone (`/api/git/credentials*`), jamais exposé au front. Routes sous `/api/git/github/*` et
`/api/git/credentials*` (module `routes/github.js`, client dans `github.js`).

### Versionnement du suivi (tracking git)

Optionnel (`MEOWTRACK_TRACKING_GIT=1`, **désactivé par défaut**). Chaque `tracker.db` (la base de suivi d'un
repo, par défaut un simple fichier sous `.trackers/<slug>/`) peut être **versionné dans une branche orpheline
`tracking`** dédiée, checkout-ée dans un **worktree** propre — **aucune histoire partagée avec le code, les
branches de code ne sont jamais touchées**. Un **committer périodique** checkpointe le WAL et commit les
changements (cadence `MEOWTRACK_TRACKING_INTERVAL_MS`) ; un commit final part à l'arrêt ; le **push est opt-in**
(`MEOWTRACK_TRACKING_PUSH=1`, vers `MEOWTRACK_TRACKING_REMOTE`) pour synchroniser le suivi **entre machines**.
Au démarrage, le worktree restaure `tracker.db` depuis la branche. L'identité de commit est dédiée
(`MEOWTRACK_TRACKING_NAME` / `_EMAIL`) et n'altère pas ta config git. Tout est best-effort : un échec git ne
casse jamais l'app (repli sur un `.trackers/<slug>/` simple). La branche `tracking` est **masquée par défaut**
des sélecteurs de branches de code. Routes dédiées : `GET/POST /api/tracking/config`, `POST /api/tracking/commit`
(forcer un commit immédiat).

## Vibes — arbre de nœuds, graphe organique & chat IA streaming

Onglet **🌱 Vibes** du dashboard : un **arbre de NŒUDS récursif** (`nodes`, ref `NODE-1`…). Un seul
type de nœud — objectif = jalon = sous-jalon — chacun avec titre, statut, couleur, emoji, échéance et une
**progression** dérivée (moyenne récursive de ses enfants ; une feuille `done` = 100 %). Profondeur libre :
un jalon « sert de goal » et peut avoir ses propres sous-jalons.

**Statut `waiting` — en attente d'information utilisateur.** En plus de `active`/`paused`/`done`/`abandoned`,
un nœud peut être **`waiting`** (⏳) : il **manque une info de l'utilisateur** (clé API, config, décision)
avant de pouvoir être implémenté. L'info attendue est décrite dans le champ **`pending_info`** (markdown libre,
**jamais** la valeur d'un secret). Un nœud `waiting` n'est **pas réclamable** par l'orchestrateur
(`claimNextNode` exige `status='active'`). Côté chat IA, quand le nœud courant est `waiting`, le prompt
**bascule en mode « collecte »** : l'assistant explique ce qui manque, aide à le réunir, puis pose
`{"op":"set_node_fields","status":"active"}` quand tout est là (ce qui efface `pending_info`). En détail de
nœud, un encart affiche `pending_info` + un bouton **« ✅ Prêt à implémenter »** (secours manuel). L'agent
Claude Code déclenche l'attente via **`meowtrack_node_request_input`** (ou `status='waiting'` + `pendingInfo`).

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

**L'IA et le MCP peuvent aussi gérer les prérequis.** Le catalogue d'actions du chat gagne `add_link` /
`remove_link` (`{from, to}` ; `from` dépend de `to`) : **scopé au sous-arbre** dans le chat d'un nœud,
**au dépôt** dans le chat « top level » ; non destructifs (auto-appliqués, mêmes garde-fous cycle/cap/auto-
lien). Le prompt liste ces actions et les **prérequis existants**, et conseille de ne pas dupliquer une
brique partagée mais de la relier. Côté MCP : `meowtrack_node_link_add`, `meowtrack_node_link_remove`,
`meowtrack_node_links` (et `meowtrack_node_get` renvoie aussi `requires` / `requiredBy`).

### Node d'activation (porte de prérequis manuelle)

Un **node d'activation** (`kind = 'activation'`, ⚡) est un nœud spécial qui sert d'**interrupteur manuel** :
tant qu'il n'est **pas activé**, il **bloque tous les nœuds qui le requièrent** ; on l'**active à la main**
pour **débloquer toute une séquence** d'un coup. Il **réutilise le moteur de prérequis** ci-dessus (aucune
nouvelle logique de blocage) : « activé » = `status='done'` (le prérequis est satisfait → les dépendants se
débloquent), « inactif » = tout autre statut (par défaut `active`). Il **garde la logique d'un nœud normal**
(chat, notes, sous-arbre, position) mais est **exclu de l'orchestrateur** (`claimNextNode` ajoute
`kind IS NOT 'activation'` → une porte n'est jamais réclamée comme tâche exécutable, même feuille et active).

- **Placement manuel** : clic droit sur le fond du graphe → **« ⚡ Node d'activation ici »** (épinglé à
  l'endroit cliqué), ou la modale de création/édition (sélecteur **Type**), ou clic droit sur un nœud
  existant → **« ⚡ Convertir en node d'activation »**.
- **Activer / désactiver** : clic droit sur la porte → **« ⚡ Activer / Désactiver »**, ou le bouton dans la
  vue détail. Pour relier les nœuds à gérer : clic droit sur la porte → **« 🔌 Bloquer un nœud (le lier)… »**
  puis cliquer la cible (le lien est posé dans le bon sens : la cible *requiert* la porte).
- **Rendu** : silhouette en **losange ambré** distincte du cercle, **lumineuse** une fois activée.
- **IA / MCP** : `add_node` / `meowtrack_node_create` avec `kind:'activation'`, et activation via
  `set_node_fields` / `status='done'`.

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

### Gérer le SUIVI (issues) depuis le chat IA

Les **deux chats** (par nœud ET « top level ») peuvent aussi **créer et organiser les entrées de suivi** du
dépôt via quatre actions supplémentaires : `add_issue` (nouvelle entrée — un `@chemin` dans la description
devient une référence fichier), `update_issue`, `delete_issue` et `reorder_issues` (ordre manuel). Comme les
entrées sont **scopées au dépôt** (pas à l'arbre de nœuds), `turns.js` **scinde** le flux d'actions : les ops
nœud partent dans `applyNodeActions`/`applyForestActions`, les ops issue dans **`applyIssueActions`**
(`db/issues.js`, qui réutilise `createIssue`/`updateIssue`/`deleteIssue`/`reorderIssues`). Mêmes garde-fous :
catalogue fermé (op inconnu rejeté), cap par tour, fail-closed ; `delete_issue` est **destructif** (→
confirmation humaine, comme `delete_node`). Le prompt reçoit un instantané compact des entrées existantes
(code + type/statut/priorité + titre) pour cibler les bons `ref`. Après application, un event SSE
`issues:changed` est diffusé sur le canal `forest:<repoId>` ; la **vue Suivi** y est abonnée et recharge sa
liste en direct. Côté MCP, l'outil `meowtrack_reorder` expose le même réordonnancement.

### Ordre manuel des entrées (glisser-déposer)

Les entrées de suivi portent une colonne `position` : **l'ordre manuel prime** sur l'ancien tri
statut→priorité→date (`listIssues` trie par `position`). Dans la liste du Suivi, on **réordonne par
glisser-déposer** ; l'ordre est persisté via `POST /api/issues/reorder` (`{ order: [code|id, …] }` →
`reorderIssues`, qui réécrit les positions et relègue les entrées non citées après — même sémantique que le
réordonnancement des nœuds). Une nouvelle entrée s'ajoute **en bas** de la liste.

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
| `GET/DELETE` | `/api/nodes/:ref/messages` | historique du chat du nœud / le vider |
| `DELETE` | `/api/nodes/:ref/messages/:id` | retirer un seul message (refusé pendant un tour IA → `409`) |
| `POST` | `/api/nodes/:ref/chat` | message (lance le tour IA streaming, `202`, résultat via SSE) |
| `POST` | `/api/nodes/:ref/chat/confirm` | confirmer une proposition destructive |
| `GET` | `/api/nodes/:ref/stream` | flux SSE du nœud (chat + stream + état du sous-arbre) |
| `GET` | `/api/nodes/stream` | flux SSE de la forêt (graphe/grille **+ chat « top level »**) |
| `GET/DELETE` | `/api/forest/messages` | historique du chat « top level » du repo / le vider |
| `DELETE` | `/api/forest/messages/:id` | retirer un seul message « top level » (refusé pendant un tour IA → `409`) |
| `POST` | `/api/forest/chat` | message « top level » (tour IA streaming, `202`, résultat via SSE forêt) |
| `POST` | `/api/forest/chat/confirm` | confirmer une proposition destructive du chat « top level » |

La concurrence repose sur `nodes.version` (entier monotone bumpé sur le nœud **et** ses ancêtres à chaque
mutation) ; le front réconcilie par version. `node_messages.id` est l'ordre total du chat. La hiérarchie
utilise un `path` matérialisé (`/1/4/9/`) → subtree/ancestors/scope en SQL pur, sans CTE.

## Notes

- Quelques tests de régression ciblés (parsing IA fail-closed + garde-fous des liens) : `node test/parse_ai_turn.test.mjs`, `node test/ghost_payload.test.mjs`, `node test/node_links.test.mjs`, `node test/node_waiting.test.mjs`, `node test/node_activation.test.mjs`.
- Le port `7702` suit la convention d'automation (`7700`/`7701`) ; en déploiement, choisir un port libre du serveur.
- L'API est protégée par `MEOWTRACK_TOKEN` quand il est défini ; le dashboard demande le token (stocké en `localStorage`) et réessaie sur `401`.
- **Token par dépôt (sécurité, NODE-372).** En plus du `MEOWTRACK_TOKEN` global (accès **admin** cross-repo, dashboard + `/mcp`), chaque dépôt porte son propre `token` (colonne `repos.token`, généré à la création, régénérable). Un **token de dépôt** authentifie le **MCP/skills** et **limite l'accès à CE seul dépôt** côté serveur (un `?repo=` divergent est rejeté ; créer/importer/supprimer des dépôts reste réservé à l'admin) — c'est le verrou mono-repo imposé côté serveur. Le token est visible dans le dashboard (topbar **🔑 token** : révéler / copier / régénérer) et déposé dans le clone sous **`.meowtrack/token`** (gitignoré). Le MCP stdio lit ce fichier depuis son `cwd` (en remontant comme un `.git`) au démarrage et l'envoie en `Bearer`. Si le fichier est absent (serveur distant), copier le token depuis l'UI. Test : `node test/repo_token.test.mjs`.
