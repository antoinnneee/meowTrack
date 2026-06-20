# Plan d'implémentation — Orchestrateur d'exécution via MCP

> Objectif : transformer l'arbre de nœuds (« Vibes ») en un **backlog exécutable**.
> Un agent (Claude Code) tire les tâches prêtes via MCP, les réalise avec ses
> propres outils (écriture/shell/git), puis rend compte. meowtrack reste une
> **couche données + transport mince** : il fournit la file de travail et la
> résolution du graphe de dépendances, il **n'exécute pas** lui-même.

## 1. Principe directeur

MCP est un protocole **d'exposition d'outils**, pas un moteur d'exécution :

- **Serveur MCP = meowtrack** (`mcp.js`) : passif. Il expose la file de tâches et
  l'état du graphe.
- **Client MCP = l'hôte agentique** (Claude Code) : il appelle les outils, fait le
  vrai travail, et signale l'avancement.

On **inverse le contrôle** par rapport au chat IA actuel (où meowtrack *spawne*
`claude -p`) : ici c'est l'agent qui **tire** (`pull`) le travail.

Conséquence assumée : **meowtrack ne peut pas pousser**. Un serveur MCP est piloté
par son client ; il n'initie rien. Il faut donc un *moteur* qui maintienne un hôte
en marche (session Claude Code, `/loop`, `/schedule`, ou — phase 4 — un scheduler
server-side qui spawne des exécuteurs pointés sur le MCP de meowtrack).

### Boucle côté agent (cible)

```
tant que (t = meowtrack_node_next(repo)) :         # une tâche prête, déjà réclamée
    … faire le travail (Read/Edit/Bash/git) dans un worktree isolé …
    meowtrack_node_complete(t.ref, { summary, branch })   # ou _fail en cas d'échec
```

## 2. Ce qui existe déjà et qu'on réutilise

| Brique | Module | Rôle dans l'orchestrateur |
| --- | --- | --- |
| DAG (arbre + liens `requires`) | `db/nodes.js`, table `node_links` | Graphe de dépendances, **acyclique garanti** (`requiresReaches`) |
| Signal « blocked » | liens `requires` | Condition « débloqué » de `node_next` |
| Rollup de progression | `recomputeAncestorProgress` | Progression remonte toute seule à la complétion |
| Concurrence optimiste | colonne `nodes.version` | Bump au claim → le front affiche « en cours » |
| Diffusion temps réel | `sse.js`, `affectedNodeIds` | Le graphe se rafraîchit en direct |
| Primitives git (écriture) | `repo.js`, `repos.js` | Branches, commit, worktrees pour l'isolation |
| Revue de diff | `routes/git.js` + device-flow GitHub | Relecture humaine / PR avant merge |

**On n'invente quasiment rien** : ~80 % de la machinerie est déjà là. On ajoute un
état d'exécution (bail) et quelques primitives/outils.

## 3. Schéma — migrations (`db/migrations.js`)

Le `status` actuel (`active|paused|done|abandoned`) décrit l'**intention**, pas
l'**exécution**. On ajoute un **bail (lease)** pour coordonner des workers, séparé
du statut planning.

### 3.1 Colonnes sur `nodes` (ALTER idempotents)

```sql
ALTER TABLE nodes ADD COLUMN run_state    TEXT;            -- NULL | 'running' | 'failed'  ('done' = miroir de status)
ALTER TABLE nodes ADD COLUMN lease_owner  TEXT;            -- id du worker détenteur
ALTER TABLE nodes ADD COLUMN lease_until  TEXT;            -- ISO : expiration du bail (NULL = libre)
ALTER TABLE nodes ADD COLUMN run_attempts INTEGER NOT NULL DEFAULT 0;
```

> `status='done'` reste la vérité « terminé » (déclenche déjà `done_at` + le rollup
> dans `_setNodeFields`). Le bail ne sert qu'à la coordination.

### 3.2 Table `node_runs` (historique d'exécution)

```sql
CREATE TABLE IF NOT EXISTS node_runs (
  id          INTEGER PRIMARY KEY,
  node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  owner       TEXT,                 -- worker
  state       TEXT NOT NULL,        -- 'running' | 'done' | 'failed'
  branch      TEXT,                 -- branche de travail (ex. meow/NODE-12)
  summary     TEXT,                 -- compte-rendu de l'agent
  error       TEXT,                 -- message d'échec
  test_result TEXT,                 -- 'pass' | 'fail' | NULL
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_runs_node ON node_runs(node_id, id);
```

> Migration : suivre le pattern existant (un bloc ALTER/CREATE try-catch dans
> `db/migrations.js`, joué par `initDb()`). Préserver le chemin `migrateLegacyMultiRepo`.

## 4. Couche données

### 4.1 `db/nodes.js` — claim & lifecycle

`node_next` = **sélection + réclamation en UNE instruction atomique** (pas de
TOCTOU). SQLite sérialise les écritures ; `UPDATE … WHERE id = (SELECT … LIMIT 1)
RETURNING *` est le compare-and-swap.

```js
// Réclame la prochaine tâche PRÊTE pour `owner`. null si rien n'est prêt.
export function claimNextNode(repoId, owner, { leaseMs = 600000, maxAttempts = 3 } = {}) {
  return withRepo(repoId, () => {
    const rid = resolveRepoId(repoId);
    const now = nowIso();
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
    const row = db.prepare(`
      UPDATE nodes
         SET run_state='running', lease_owner=@owner, lease_until=@leaseUntil,
             run_attempts = run_attempts + 1, version = version + 1, updated_at=@ts
       WHERE id = (
         SELECT n.id FROM nodes n
          WHERE n.repo_id = @repo
            AND n.status  = 'active'
            AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id)        -- feuille
            AND (n.run_state IS NULL OR n.run_state = 'failed')                    -- pas en cours/finie
            AND n.run_attempts < @maxAttempts
            AND (n.lease_owner IS NULL OR n.lease_until < @now)                    -- bail libre/expiré
            AND NOT EXISTS (                                                       -- tous prérequis done
              SELECT 1 FROM node_links l JOIN nodes p ON p.id = l.to_id
               WHERE l.from_id = n.id AND l.kind = 'requires' AND p.status <> 'done'
            )
          ORDER BY (n.target_date IS NULL), n.target_date, n.depth, n.position, n.id
          LIMIT 1
       )
      RETURNING *`).get({ repo: rid, owner, leaseUntil, now, ts: now, maxAttempts });
    return row ? rowToNode(row) : null;
  });
}

// Prolonge le bail (heartbeat des tâches longues). false → bail perdu (préempté).
export function renewLease(nodeId, owner, leaseMs = 600000) {
  const until = new Date(Date.parse(nowIso()) + leaseMs).toISOString();
  return db.prepare(
    "UPDATE nodes SET lease_until=? WHERE id=? AND lease_owner=? AND run_state='running'"
  ).run(until, nodeId, owner).changes === 1;
}

// Clôt une tâche : seul le détenteur du bail peut clore.
export function completeNode(nodeId, owner, { summary, branch, testResult } = {}, repoId = null) {
  return withRepo(repoId, () => {
    db.transaction(() => {
      const ok = db.prepare(
        "UPDATE nodes SET run_state='done', lease_owner=NULL, lease_until=NULL WHERE id=? AND lease_owner=?"
      ).run(nodeId, owner).changes === 1;
      if (!ok) { const e = new Error("bail_perdu"); e.code = "lease_lost"; throw e; }
      _setNodeFields(nodeId, { status: "done" });             // → done_at + statut
      const aff = recomputeAncestorProgress(nodeId, { bumpSelf: true }); // → progression remonte
      finishRun(nodeId, owner, "done", { summary, branch, testResult }); // node_runs
      return aff;
    })();
  });
}

// Échec : libère le bail, laisse run_state='failed' (rejouable tant que attempts < max).
export function failNode(nodeId, owner, { error, branch } = {}, repoId = null) {
  return withRepo(repoId, () => {
    db.transaction(() => {
      db.prepare(
        "UPDATE nodes SET run_state='failed', lease_owner=NULL, lease_until=NULL WHERE id=? AND lease_owner=?"
      ).run(nodeId, owner);
      finishRun(nodeId, owner, "failed", { error, branch });
    })();
  });
}
```

**Pas de tri topologique** : le graphe étant acyclique, piquer une feuille
débloquée puis la clore débloque mécaniquement ses dépendants au tour suivant — la
« vague » d'exécution émerge seule.

### 4.2 `db/runs.js` (nouveau) — historique

```js
export function startRun(nodeId, owner, branch) { /* INSERT node_runs state='running' */ }
export function finishRun(nodeId, owner, state, { summary, error, branch, testResult }) { /* UPDATE le run ouvert */ }
export function listRuns(nodeRefOrId, repoId) { /* historique pour l'UI/MCP */ }
```

> `startRun` peut être appelé dans `claimNextNode` (même transaction) pour qu'un run
> existe dès la réclamation.

### 4.3 Barrel `db.js`

Ré-exporter `claimNextNode`, `renewLease`, `completeNode`, `failNode`, `listRuns`
(les transports n'importent que depuis `db.js`).

### 4.4 Auto-promotion des jalons (décision recommandée)

Un prérequis peut pointer un **parent** (jalon), jamais mis `done` automatiquement.
Pour que « prérequis satisfait » soit cohérent feuille **ou** jalon : dans
`recomputeAncestorProgress`, passer un parent à `status='done'` quand sa progression
atteint 100 (et tous enfants `done`). ~3 lignes. Alternative : exiger une clôture
explicite du parent.

## 5. Outils MCP (`mcp.js`)

Additifs, alignés sur les `meowtrack_node_*` existants. Tous prennent `repo`.

| Outil | Entrée | Sortie | Rôle |
| --- | --- | --- | --- |
| `meowtrack_node_next` | `{ repo, owner }` | tâche réclamée ou `null` | Tire + réclame la prochaine tâche prête |
| `meowtrack_node_heartbeat` | `{ ref, owner }` | `{ ok }` | Prolonge le bail (tâches longues) |
| `meowtrack_node_complete` | `{ ref, owner, summary, branch?, testResult? }` | `{ ok, affected }` | Clôt en succès → déblocage + rollup |
| `meowtrack_node_fail` | `{ ref, owner, error, branch? }` | `{ ok }` | Échec borné (retry tant que attempts < max) |
| `meowtrack_node_runs` | `{ repo, ref }` | `[runs]` | Historique d'exécution d'un nœud |

> `owner` = identifiant stable du worker (ex. `host-pid` ou un uuid passé par
> l'agent). Sert au CAS du bail et à tracer les runs.

## 6. Routes HTTP (optionnel, pour le dashboard)

Pour piloter/superviser depuis la SPA (mêmes primitives data) :

- `POST /api/nodes/next` `{ owner }` → réclame (parité avec le MCP).
- `POST /api/nodes/:ref/complete` / `/fail` / `/heartbeat`.
- `GET  /api/nodes/:ref/runs` → historique.
- Broadcast `git:changed` / `affectedNodeIds` déjà câblés pour le rafraîchissement.

Un badge « en cours / échoué » par nœud dans `vibes.js` (depuis `run_state`) suffit
pour la visualisation.

## 7. Flux d'exécution (cible)

```
            ┌─────────────────────────── meowtrack (serveur MCP) ───────────────────────────┐
            │  nodes (DAG + bail) · node_links (requires) · node_runs (historique)            │
            └──────────────▲───────────────────────────────────────────────▲────────────────┘
                           │ node_next / heartbeat / complete / fail        │ (SSE: affected)
                           │                                                 │
   ┌───────────────────────┴───────────────┐                       ┌────────┴───────────┐
   │  Agent exécuteur (Claude Code)         │                       │  Dashboard (SPA)   │
   │  1. node_next → réclame une feuille    │                       │  badges run_state  │
   │  2. worktree meow/NODE-x (isolation)   │                       │  revue de diff     │
   │  3. Read/Edit/Bash : fait le travail   │                       └────────────────────┘
   │  4. lance les tests du repo            │
   │  5. heartbeat pendant le travail long  │
   │  6. complete{summary,branch} | fail    │
   └────────────────────────────────────────┘
```

Étape de **revue humaine** entre l'exécution et le merge sur `main` : l'agent
produit un diff/branche/PR ; un humain relit via le gestionnaire git existant et
merge. **Jamais d'auto-merge sur `main`.**

## 8. Sécurité & isolation (point critique)

Le modèle actuel repose sur « l'IA n'écrit jamais » (sandbox lecture seule). Un
exécuteur **inverse ça** : la sécurité devient l'**isolation**, pas l'abstinence.

- **Un worktree + une branche par tâche** (`meow/NODE-<ref>`), jamais `main`.
  (`repo.js`/`repos.js` savent déjà créer worktrees & branches.)
- **Porte humaine obligatoire** avant merge : diff relu via `routes/git.js`.
- **Bornes** : `run_attempts < max`, timeout par tâche, bail qui expire.
- **Env** : conserver le strip du token (`AI_ENV`) ; ne jamais exposer
  `MEOWTRACK_TOKEN` à l'agent exécuteur.
- **`MEOWTRACK_TOKEN` obligatoire** sur le `/mcp` exposé (déjà géré par le gate).

## 9. Concurrence

- **Exclusivité** : le `UPDATE…WHERE…RETURNING` de `claimNextNode` garantit que
  deux workers n'obtiennent jamais la même tâche (CAS sur l'écriture, jamais sur le
  `SELECT`).
- **Workers parallèles** = plusieurs processus → chacun sa connexion à
  `tracker.db` (WAL : lecteurs concurrents + 1 écrivain).
- **`PRAGMA busy_timeout`** : vérifier qu'il est posé à l'ouverture
  (`db/connection.js`) pour que le CAS attende au lieu d'échouer en `SQLITE_BUSY`
  sous contention.
- **Crash recovery** : un worker mort laisse un bail qui **expire** → la tâche
  redevient réclamable. Le heartbeat (`renewLease`) prolonge pour les tâches
  longues ; s'il renvoie `false`, le worker a été préempté et doit abandonner.

## 10. Phases d'implémentation

1. **Données & file (pull pur)** — migrations (3.1, 3.2), `claimNextNode` /
   `renewLease` / `completeNode` / `failNode`, `db/runs.js`, barrel. Tests unitaires.
2. **MCP** — les 5 outils (§5). Validés depuis une session Claude Code manuelle :
   « vide le backlog meowtrack du repo X ».
3. **Dashboard** — routes HTTP (§6) + badges `run_state` + lien vers les runs.
4. **Autonomie (optionnel)** — scheduler server-side qui, quand des tâches sont
   prêtes, spawne des exécuteurs `claude -p` pointés sur le MCP de meowtrack
   (`--mcp-config`) avec outils d'écriture + worktree. Réutilise §1–§9 ; n'invente
   pas de scheduler/vérif (l'agent les a).

> Démarrer par les phases 1–2 valide toute la chaîne avec ~50–80 lignes et zéro
> risque (aucun spawn server-side, pilotage manuel). La phase 4 ne jette rien : les
> outils de coordination sont identiques.

## 11. Tests (pattern `test/*.test.mjs`, `MEOWTRACK_NO_LISTEN=1`)

- **`node_claim.test.mjs`** : `claimNextNode` ne rend que des feuilles `active`
  débloquées ; respecte `maxAttempts` ; un nœud à prérequis non-`done` n'est jamais
  rendu ; deux claims successifs rendent deux nœuds distincts ; un bail expiré
  redevient réclamable.
- **`node_complete.test.mjs`** : `completeNode` met `status='done'`, fait remonter
  la progression, et débloque un dépendant (qui devient réclamable au tour
  suivant) ; `completeNode` par un non-détenteur échoue (`lease_lost`).
- Étendre `node_links.test.mjs` : un cycle reste refusé (garantit la terminaison
  du « pique une feuille débloquée »).

## 12. Déploiement (`deploy.sh`)

- `mcp.js` et les modules `db/` sont déjà copiés (`db/` est récursif). **`db/runs.js`
  ne nécessite aucune édition d'allowlist.**
- Un nouveau module **racine** (ex. un scheduler `orchestrator.js` en phase 4) doit
  être **ajouté à `FILES`** dans `deploy.sh`, sinon `ERR_MODULE_NOT_FOUND` au boot.
- Un nouveau `dashboard/*.js` doit être ajouté à `DASHBOARD_FILES`.

## 13. Variables d'environnement (proposées)

| Var | Défaut | Rôle |
| --- | --- | --- |
| `MEOWTRACK_RUN_LEASE_MS` | `600000` | Durée d'un bail (10 min) |
| `MEOWTRACK_RUN_MAX_ATTEMPTS` | `3` | Retries avant `failed` définitif |
| `MEOWTRACK_RUN_PARALLEL` | `1` | (phase 4) exécuteurs simultanés par repo |
| `MEOWTRACK_RUN_BRANCH_PREFIX` | `meow/` | Préfixe des branches de travail |

## 14. Décisions ouvertes

- **Prérequis sur jalon** : auto-promotion à `done` (recommandé, §4.4) vs clôture
  explicite.
- **Commande de test par repo** : où la configurer (champ `repos` registry ?) pour
  la boucle de vérification.
- **Granularité « exécutable »** : feuilles uniquement (proposé) vs autoriser un
  jalon « tâche composite ».
- **Autonomie** : pilotage manuel/`/loop` (simple) vs scheduler server-side qui
  spawne (phase 4).

---

*Récapitulatif : ~4 colonnes + 1 table + 4 primitives + 5 outils MCP. Le tri topo
n'existe pas (il émerge). L'exclusivité tient en une instruction SQL. Déblocage et
rollup sont déjà codés — déclenchés en posant `status='done'`.*
