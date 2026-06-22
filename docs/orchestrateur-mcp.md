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
tant que (t = meowtrack_node_next(repo)) :          # une tâche prête, déjà réclamée
    … faire le travail (Read/Edit/Bash/git) dans un WORKTREE ISOLÉ …
    écrire .meowtrack/runs/<ref>.json               # rapport + points de revue (§6)
    r = meowtrack_node_complete(t.ref, { … })        # le serveur ingère le rapport
    merger la branche de travail dans `main` + push  # intégration continue (cf. ci-dessous)
    si r.hint == "compact_suggested" et contexte > seuil (≈30 %) :
        /compact                                     # césure AVANT de réclamer le nœud suivant
```

### Isolation (worktree) + intégration continue (merge `main`) entre nœuds

Deux consignes adressées à **l'agent** (meowtrack reste passif, il n'exécute aucun git) :

- **Worktree isolé** : faire le travail de chaque nœud dans un git worktree dédié
  (`repo.js`/`repos.js` exposent les primitives), pour ne pas polluer la copie de
  travail principale ni mélanger deux nœuds.
- **Merger dans `main` entre chaque nœud** : après `meowtrack_node_complete`, intégrer
  la branche de travail dans `main` (commit + merge/FF + push) **avant** de réclamer le
  nœud suivant. En mode batch séquentiel (un seul contexte qui enchaîne les nœuds), cela
  garde `main` à jour pour les nœuds suivants (qui peuvent dépendre du travail précédent)
  et borne la taille des diffs. **Garde-fou** : c'est une consigne — l'agent décide et
  exécute le git ; meowtrack ne force ni ne vérifie rien.

### Consigne de compactage (mode batch « traite les nœuds en attente »)

En mode batch (sans `/loop`), le contexte de la session croît de façon **monotone** :
chaque nœud ajoute son travail. `meowtrack_node_complete` est le **seul point de
césure fiable** de la boucle. Quand le réglage `auto_compact` est ON (§5.2), sa
réponse porte deux champs (cf. NODE-305/306) :

- `hint: "compact_suggested"` — drapeau machine (à tester en code/consigne) ;
- `advice: "Contexte potentiellement chargé : envisage un /compact …"` — texte lisible.

**meowtrack conseille, il ne décide pas** : il ne mesure pas le % de contexte. Le
déclenchement reste **côté agent**. Consigne réutilisable à coller dans le prompt de
traitement par lot :

> Après **chaque** `meowtrack_node_complete`, lis le champ `hint`. S'il vaut
> `compact_suggested` **et** que ton contexte dépasse ~30 %, lance `/compact` **avant**
> de réclamer le nœud suivant (`meowtrack_node_next`). Sinon, enchaîne directement.

Le seuil (30 %) est arbitré par l'agent ; meowtrack ne le mesure jamais.

## 2. Ce qui existe déjà et qu'on réutilise

| Brique | Module | Rôle dans l'orchestrateur |
| --- | --- | --- |
| DAG (arbre + liens `requires`) | `db/nodes.js`, table `node_links` | Graphe de dépendances, **acyclique garanti** (`requiresReaches`) |
| Signal « blocked » | liens `requires` | Condition « débloqué » de `node_next` |
| Rollup de progression | `recomputeAncestorProgress` | Progression remonte toute seule à la complétion |
| Catalogue d'actions IA validé | `applyNodeActions` (scope sous-arbre) | Applique les retours de revue **en toute sécurité** (§6) |
| Réglages par machine | table `app_settings` (registry) | Config de l'orchestrateur éditable depuis l'UI (§5) |
| Concurrence optimiste | colonne `nodes.version` | Bump au claim → le front affiche « en cours » |
| Diffusion temps réel | `sse.js`, `affectedNodeIds` | Le graphe se rafraîchit en direct |
| Primitives git (écriture) | `repo.js`, `repos.js` | Branches, commit, worktrees pour l'isolation |
| Revue de diff | `routes/git.js` + device-flow GitHub | Relecture humaine / PR avant merge |

**On n'invente quasiment rien** : ~80 % de la machinerie est déjà là. On ajoute un
état d'exécution (bail), un canal de retour par fichier, la config en UI, et
quelques primitives/outils.

## 3. Schéma — migrations (`db/migrations.js`)

Le `status` actuel (`active|paused|done|abandoned`) décrit l'**intention**, pas
l'**exécution**. On ajoute un **bail (lease)** pour coordonner des workers, séparé
du statut planning.

### 3.1 Colonnes sur `nodes` (ALTER idempotents)

```sql
ALTER TABLE nodes ADD COLUMN run_state    TEXT;            -- NULL | 'running' | 'review' | 'failed'  ('done' = miroir de status)
ALTER TABLE nodes ADD COLUMN lease_owner  TEXT;            -- id du worker détenteur
ALTER TABLE nodes ADD COLUMN lease_until  TEXT;            -- ISO : expiration du bail (NULL = libre)
ALTER TABLE nodes ADD COLUMN run_attempts INTEGER NOT NULL DEFAULT 0;
```

> `status='done'` reste la vérité « terminé » (déclenche déjà `done_at` + le rollup
> dans `_setNodeFields`). Le bail ne sert qu'à la coordination. `run_state='review'`
> = en attente d'un retour humain (ne débloque PAS les dépendants, non réclamable).

### 3.2 Table `node_runs` (historique d'exécution)

```sql
CREATE TABLE IF NOT EXISTS node_runs (
  id          INTEGER PRIMARY KEY,
  node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  owner       TEXT,                 -- worker
  state       TEXT NOT NULL,        -- 'running' | 'done' | 'review' | 'failed'
  branch      TEXT,                 -- branche de travail (ex. meow/NODE-12)
  summary     TEXT,                 -- compte-rendu de l'agent
  error       TEXT,                 -- message d'échec
  test_result TEXT,                 -- 'pass' | 'fail' | NULL
  report      TEXT,                 -- JSON brut du fichier .meowtrack/runs/<ref>.json (§6)
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_runs_node ON node_runs(node_id, id);
```

### 3.3 Table `node_reviews` (points de revue — §6)

```sql
CREATE TABLE IF NOT EXISTS node_reviews (
  id          INTEGER PRIMARY KEY,
  node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  run_id      INTEGER REFERENCES node_runs(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,        -- 'decision' | 'question' | 'risk' | 'discovery'
  message     TEXT NOT NULL,        -- le point soulevé par l'agent
  blocking    INTEGER NOT NULL DEFAULT 0,
  suggested   TEXT,                 -- JSON : actions proposées (catalogue applyNodeActions)
  state       TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved' | 'dismissed'
  response    TEXT,                 -- réponse humaine
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_reviews_open ON node_reviews(node_id, state);
```

> Migrations : suivre le pattern existant (blocs ALTER/CREATE try-catch dans
> `db/migrations.js`, joués par `initDb()`). Préserver `migrateLegacyMultiRepo`.

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
            AND (n.run_state IS NULL OR n.run_state = 'failed')                    -- ni en cours, ni en revue, ni finie
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
// hasBlockingReview → la tâche passe en 'review' (ne débloque PAS) au lieu de 'done'.
export function completeNode(nodeId, owner, { summary, branch, testResult, hasBlockingReview } = {}, repoId = null) {
  return withRepo(repoId, () => {
    db.transaction(() => {
      const next = hasBlockingReview ? "review" : "done";
      const ok = db.prepare(
        "UPDATE nodes SET run_state=?, lease_owner=NULL, lease_until=NULL WHERE id=? AND lease_owner=?"
      ).run(next, nodeId, owner).changes === 1;
      if (!ok) { const e = new Error("bail_perdu"); e.code = "lease_lost"; throw e; }
      if (!hasBlockingReview) {
        _setNodeFields(nodeId, { status: "done" });             // → done_at + statut
        recomputeAncestorProgress(nodeId, { bumpSelf: true });  // → progression remonte
      }
      finishRun(nodeId, owner, next, { summary, branch, testResult });
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

### 4.2 `db/runs.js` (nouveau) — historique + ingestion des rapports

```js
export function startRun(nodeId, owner, branch) { /* INSERT node_runs state='running' */ }
export function finishRun(nodeId, owner, state, { summary, error, branch, testResult, report }) { /* UPDATE le run ouvert */ }
export function listRuns(nodeRefOrId, repoId) { /* historique pour l'UI/MCP */ }

// Ingère un rapport (objet déjà parsé fail-closed depuis .meowtrack/runs/<ref>.json).
// Persiste les reviewPoints en node_reviews ; applique nodeUpdates via applyNodeActions
// (scope sous-arbre, destructif → confirmation). Renvoie { hasBlockingReview, applied }.
export function ingestRunReport(nodeId, runId, report, repoId) { /* … */ }
```

### 4.3 `db/registry.js` — config orchestrateur (app_settings)

```js
// Lit la config effective : défauts d'env, écrasés par app_settings (UI), puis par
// les overrides par repo (table repos). Voir §5.
export function getOrchestratorConfig(repoId = null) { /* … */ }
export function setOrchestratorConfig(patch, { repoId = null } = {}) { /* écrit app_settings / repos */ }
```

### 4.4 Barrel `db.js`

Ré-exporter `claimNextNode`, `renewLease`, `completeNode`, `failNode`, `listRuns`,
`ingestRunReport`, `listReviews`, `resolveReview`, `getOrchestratorConfig`,
`setOrchestratorConfig` (les transports n'importent que depuis `db.js`).

### 4.5 Auto-promotion des jalons (décision recommandée)

Un prérequis peut pointer un **parent** (jalon), jamais mis `done` automatiquement.
Pour que « prérequis satisfait » soit cohérent feuille **ou** jalon : dans
`recomputeAncestorProgress`, passer un parent à `status='done'` quand sa progression
atteint 100 (et tous enfants `done`). ~3 lignes. Alternative : clôture explicite.

## 5. Configuration de l'orchestrateur **dans l'interface**

Les réglages ne doivent pas vivre seulement dans `.env` : ils doivent être
**éditables depuis le dashboard**, sans redéploiement. On réutilise la table
`app_settings` (registry, par machine) — même précédent que le `client_id` GitHub
custom.

### 5.1 Modèle de précédence

```
défaut d'env  (MEOWTRACK_RUN_*)   →  app_settings (UI, global)  →  override par repo (table repos)
   bootstrap / fallback                réglage live machine          réglage spécifique projet
```

`getOrchestratorConfig(repoId)` fusionne ces trois couches. L'UI écrit dans
`app_settings` (global) ou dans la ligne `repos` (spécifique).

### 5.2 Réglages exposés

| Clé | Portée | Défaut | Rôle |
| --- | --- | --- | --- |
| `run.leaseMs` | global / repo | `600000` | Durée d'un bail |
| `run.maxAttempts` | global / repo | `3` | Retries avant `failed` |
| `run.parallel` | global / repo | `1` | (phase 4) exécuteurs simultanés/repo |
| `run.branchPrefix` | global | `meow/` | Préfixe des branches de travail |
| `run.testCommand` | **repo** | `null` | Commande de test lancée après chaque tâche |
| `run.autoApplyUpdates` | global | `false` | Appliquer les `nodeUpdates` non destructifs sans confirmation |
| `review.autoReview` | global / repo | `false` | Déclenche une auto-revue (chat IA top-level) sur point de revue (§6.6) |
| `review.autoReviewModel` | global | `sonnet` | Modèle de l'auto-revue (`sonnet`/`opus`/`haiku`) |
| `review.autoReviewPrompt` | global / repo | `null` | **Prompt de politique** préparé d'avance, injecté dans l'auto-revue (§6.6) |

### 5.3 Surface

- **Routes** : `GET /api/settings/orchestrator?repo=` (config effective + origine de
  chaque valeur) et `PUT /api/settings/orchestrator` `{ scope:'global'|'repo', repo?, patch }`.
- **UI** : un panneau « Orchestrateur » (dans les réglages du dashboard, à côté de
  l'auth GitHub). Champs typés, validation côté serveur (allowlist de clés, bornes
  numériques), indication « hérité de l'env / défini globalement / défini pour ce
  repo ». Le token et les secrets ne transitent jamais par ce panneau.

## 6. Points de revue via **artefact fichier**

Besoin : le modèle qui code laisse **un fichier dans le repo** pour donner un retour
structuré côté serveur, qui peut **mettre à jour les éléments** (nœuds) selon les
résultats. C'est le canal de feedback de la boucle.

### 6.1 Pourquoi un fichier (et pas seulement l'appel MCP)

- **Durable & auditable** : le fichier vit dans le worktree, donc dans le diff/PR ;
  on voit exactement ce que l'agent a rapporté.
- **Découplé** : « faire le travail » ≠ « rapporter ». Le serveur peut ingérer le
  rapport même si la session MCP s'est terminée.
- **Riche** : il porte des `nodeUpdates` (découvertes → modifs du graphe) et des
  `reviewPoints` (questions/décisions persistantes) que `complete` seul ne capte pas.

### 6.2 Convention de fichier

L'agent écrit, à la racine de son worktree :

```
.meowtrack/runs/<ref>.json        # ex. .meowtrack/runs/NODE-12.json
```

Schéma (parsé **fail-closed**, comme `ai/parse.js` : au moindre doute → 0 action,
rapport conservé tel quel pour inspection) :

```json
{
  "ref": "NODE-12",
  "state": "done | needs_review | failed",
  "summary": "Ce qui a été fait, en clair.",
  "branch": "meow/NODE-12",
  "testResult": "pass | fail | skipped",
  "nodeUpdates": [
    { "op": "add_node", "title": "Écrire les tests d'intégration", "tmpKey": "t1" },
    { "op": "set_node_fields", "status": "done" },
    { "op": "add_link", "from": "<id>", "to": "<id>" }
  ],
  "reviewPoints": [
    { "kind": "decision", "message": "API REST ou WebSocket ? J'ai pris REST.", "blocking": true,
      "suggestedActions": [ { "op": "add_node", "title": "Migrer vers WebSocket si besoin" } ] }
  ]
}
```

### 6.3 Ingestion côté serveur

Au `complete`/`fail` (ou via un outil/route dédié `node_review`), le serveur :

1. **Lit** `.meowtrack/runs/<ref>.json` depuis le worktree de la tâche (lecture
   bornée, anti-traversal — réutilise la validation de chemin de `repo.js`).
2. **Parse fail-closed** ; stocke le JSON brut dans `node_runs.report`.
3. **Applique `nodeUpdates`** via `applyNodeActions(scope=nodeId, …)` : scope validé
   au sous-arbre, cap par tour, **destructif → proposition + confirmation humaine**
   (jamais d'auto-suppression). `run.autoApplyUpdates` (§5.2) ne lève l'auto-apply
   que pour le **non destructif**.
4. **Persiste les `reviewPoints`** en `node_reviews`. S'il y en a un `blocking:true`,
   `completeNode` est appelé avec `hasBlockingReview` → la tâche passe en
   `run_state='review'` : elle **ne débloque pas** ses dépendants tant qu'un humain
   n'a pas tranché.
5. **Broadcast SSE** (`affectedNodeIds`, `links:changed`, + un `review:open`) → le
   dashboard surface les points de revue en direct.

### 6.4 Boucle de retour humain

- **Dashboard** : panneau « Points de revue » (par nœud + une file globale par
  repo). Chaque point : message, type, actions suggérées.
- **Résolution humaine** (`POST /api/nodes/:ref/reviews/:id/resolve` `{ decision, applyActions? }`) :
  - *approuver* → applique les `suggestedActions` (via `applyNodeActions`), marque le
    point `resolved` ; si plus aucun point bloquant, on **promeut** la tâche
    `review → done` (donc déblocage + rollup).
  - *rejeter / retravailler* → `dismissed` ou remet la tâche `active`
    (`run_state=NULL`) pour un nouveau passage (attempts incrémenté).
- **Résolution automatique** (§6.6) : un point de revue peut aussi être traité par le
  **chat IA top-level**, qui réorganise l'arbre/les tâches en réponse.
- C'est le « possiblement mettre à jour les éléments selon les résultats » : la
  résolution peut créer des sous-tâches, changer des statuts, ajouter des prérequis
  — tout passe par le catalogue d'actions sûr.

### 6.5 Sort du fichier

Le fichier reste sur la **branche de travail** (auditable dans la PR). Option : le
serveur peut le déplacer/archiver après ingestion. Ne **jamais** l'ingérer depuis
`main` — uniquement depuis le worktree de la tâche.

### 6.6 Auto-revue par le **chat IA top-level**

Plutôt qu'un humain, c'est le **chat IA de la forêt** (top-level) qui répond au point
de revue en **remodifiant l'arbre de nœuds et/ou les tâches**. On ne crée pas un
nouveau pipeline : on **réutilise le chat forêt existant** (`runForestTurn` /
`buildForestPrompt` / `applyForestActions`), qui sait déjà créer/déplacer/supprimer
des nœuds, réordonner et (dé)lier des prérequis, à l'échelle du repo.

**Entrée = un tour de chat forêt synthétique.** Au lieu d'un message humain, on
fabrique le message à partir du contexte de revue :

```
buildForestPrompt(forêt, historique, userMessage = ⟨contexte de revue⟩, …)
   ⟨contexte de revue⟩ =
     - le(s) reviewPoint(s) ouvert(s) (message, kind, blocking, suggestedActions)
     - le résumé du run + testResult + la branche
     - le nœud d'origine (ref/titre) et son sous-arbre
     - [optionnel] le PROMPT DE POLITIQUE préparé d'avance (review.autoReviewPrompt)
```

**Le prompt de politique optionnel** (`review.autoReviewPrompt`, §5.2) est un texte
**préparé à l'avance** par l'utilisateur (global ou par repo), injecté en tête du
message synthétique. Il encode *comment* arbitrer — p. ex. « privilégie la
décomposition en sous-tâches testables », « ne supprime jamais un jalon, marque-le
`abandoned` », « si testResult=fail, crée une tâche de correction et relie-la ».
C'est de la **donnée de configuration**, traitée comme le reste du contenu : le bloc
de revue lui-même reste *untrusted* (anti-injection, `stripUntrustedMarkers`), seule
la politique est une consigne de confiance car posée par l'admin via l'UI.

**Application = `applyForestActions`** (scope repo). Mêmes garde-fous que le chat
forêt manuel : cap par tour, anti-cycle, et **action destructive → proposition +
confirmation humaine** (jamais d'auto-suppression). Donc « auto » ne veut pas dire
« sans filet » : une réorganisation non destructive s'applique seule, une suppression
attend un clic humain.

**Traçabilité.** Le tour s'enregistre comme un **message du chat forêt** (rôle
assistant, auteur `auto-review`) → il apparaît dans l'historique top-level et se
diffuse en SSE (`forest:<repoId>`). Le(s) point(s) de revue traité(s) passent
`resolved` (avec un lien vers le message) ; si plus aucun point bloquant ne reste, la
tâche est promue `review → done`.

**Déclenchement** — deux modes, selon `review.autoReview` :
- *à la demande* : bouton « Auto-réviser » sur le point de revue (route/MCP dédiés),
  même si `autoReview=false`.
- *automatique* : si `review.autoReview=true` (global ou repo), l'ingestion d'un
  point de revue lance directement l'auto-revue en tâche de fond (réutilise le
  détachement 202 + SSE de `handleForestChat`).

**Boucle bornée.** Pour éviter qu'une auto-revue regénère des points qui relancent
une auto-revue à l'infini : un compteur d'auto-revues par nœud (réutiliser
`run_attempts` ou un champ dédié), plafonné ; au-delà → bascule en revue **humaine**.

```js
// ai/turns.js — pendant programmatique de handleForestChat (pas d'humain).
export async function autoReviewForest(repoId, nodeId, reviewIds, { model, policyPrompt } = {}) {
  // 1. charge la forêt + liens + le contexte de revue (reviews, dernier run)
  // 2. message synthétique = policyPrompt (confiance) + bloc revue (untrusted)
  // 3. runForestTurn(...) → parse fail-closed → applyForestActions (destructif → proposé)
  // 4. enregistre le message forêt (author='auto-review'), broadcast SSE
  // 5. marque les reviews resolved ; promeut review→done si plus de point bloquant
}
```

## 7. Outils MCP (`mcp.js`)

Additifs, alignés sur les `meowtrack_node_*` existants. Tous prennent `repo`.

| Outil | Entrée | Sortie | Rôle |
| --- | --- | --- | --- |
| `meowtrack_node_next` | `{ repo, owner }` | tâche réclamée ou `null` | Tire + réclame la prochaine tâche prête |
| `meowtrack_node_heartbeat` | `{ ref, owner }` | `{ ok }` | Prolonge le bail (tâches longues) |
| `meowtrack_node_complete` | `{ ref, owner, summary?, branch?, testResult? }` | `{ ok, state, affected, reviews, hint?, advice? }` | Clôt → ingère le rapport (§6) → déblocage **ou** revue ; `hint`/`advice` si `auto_compact` ON (§1) |
| `meowtrack_node_fail` | `{ ref, owner, error, branch? }` | `{ ok }` | Échec borné (retry tant que attempts < max) |
| `meowtrack_node_runs` | `{ repo, ref }` | `[runs]` | Historique d'exécution d'un nœud |
| `meowtrack_node_reviews` | `{ repo, ref?, state? }` | `[reviews]` | Lit les points de revue (ouverts/résolus) |
| `meowtrack_review_auto` | `{ repo, ref, reviewIds?, model? }` | `{ message, applied, resolved }` | Lance l'**auto-revue** (chat IA top-level) sur des points de revue (§6.6) |

> `complete` lit `.meowtrack/runs/<ref>.json` dans le worktree : l'agent peut donc se
> contenter d'écrire le fichier puis d'appeler `complete` (les détails passent par le
> fichier, pas par des args géants).

## 8. Routes HTTP (dashboard)

Mêmes primitives data que le MCP :

- File : `POST /api/nodes/next` `{ owner }`, `POST /api/nodes/:ref/{complete,fail,heartbeat}`.
- Historique : `GET /api/nodes/:ref/runs`.
- Revue : `GET /api/nodes/reviews?state=open` (file globale), `GET /api/nodes/:ref/reviews`,
  `POST /api/nodes/:ref/reviews/:id/resolve`.
- Auto-revue (§6.6) : `POST /api/nodes/:ref/reviews/auto` `{ reviewIds?, model? }` — lance
  un tour de chat forêt synthétique ; répond `202` puis streame en SSE (`forest:<repoId>`).
- Réglages : `GET/PUT /api/settings/orchestrator` (§5.3).
- Front (`vibes.js`) : badges `run_state` (en cours / revue / échoué), panneau
  « Points de revue », panneau « Orchestrateur ». SSE déjà câblé pour le rafraîchissement.

## 9. Flux d'exécution (cible)

```
            ┌──────────────────────────── meowtrack (serveur MCP + HTTP) ─────────────────────────────┐
            │  nodes (DAG + bail) · node_links · node_runs · node_reviews · app_settings (config UI)    │
            └──────────▲──────────────────────────────▲───────────────────────────────▲────────────────┘
                       │ next/heartbeat/complete/fail  │ ingère .meowtrack/runs/<ref>   │ SSE (review:open)
                       │                               │                                │
   ┌───────────────────┴───────────────┐              │                       ┌─────────┴──────────┐
   │  Agent exécuteur (Claude Code)     │              │                       │  Dashboard (SPA)   │
   │  1. node_next → réclame une feuille│              │                       │  badges run_state  │
   │  2. worktree meow/NODE-x (isolation)│             │                       │  Points de revue → │
   │  3. Read/Edit/Bash : fait le travail│             │                       │   résout → maj nœuds│
   │  4. lance run.testCommand          │              │                       │  panneau réglages  │
   │  5. ÉCRIT .meowtrack/runs/<ref>.json│─────────────┘                       │  revue de diff/PR  │
   │  6. complete | fail                │                                      └────────────────────┘
   └────────────────────────────────────┘
```

Étape de **revue** entre l'exécution et le merge sur `main` : l'agent produit
branche + diff + rapport ; les points de revue sont tranchés par un humain **ou** par
l'auto-revue IA top-level (§6.6, qui remodifie l'arbre/les tâches), puis un humain
relit le diff (gestionnaire git) et merge. **Jamais d'auto-merge sur `main`.**

## 10. Sécurité & isolation (point critique)

Le modèle actuel repose sur « l'IA n'écrit jamais » (sandbox lecture seule). Un
exécuteur **inverse ça** : la sécurité devient l'**isolation**, pas l'abstinence.

- **Un worktree + une branche par tâche** (`<branchPrefix>NODE-<ref>`), jamais `main`.
- **Lecture du rapport bornée** : seulement `.meowtrack/runs/<ref>.json`, validation
  anti-traversal (`repo.js`), taille plafonnée, parse fail-closed.
- **`nodeUpdates`/`suggestedActions`** passent par `applyNodeActions` : scope
  sous-arbre, cap par tour, destructif → confirmation. Une découverte d'agent ne peut
  pas supprimer hors scope ni en masse.
- **Porte humaine** avant merge ; **bornes** (`maxAttempts`, timeout, bail expirable).
- **Auto-revue** : le bloc de revue est *untrusted* (`stripUntrustedMarkers`,
  anti-injection) ; seule la politique (`review.autoReviewPrompt`, posée par l'admin
  via l'UI) est de confiance. Actions via `applyForestActions` (destructif →
  confirmation) ; compteur d'auto-revues plafonné (anti-boucle).
- **Env** : conserver le strip du token (`AI_ENV`) ; ne jamais exposer
  `MEOWTRACK_TOKEN` à l'agent. `/mcp` exigé derrière `Authorization: Bearer`.

## 11. Concurrence

- **Exclusivité** : le `UPDATE…WHERE…RETURNING` de `claimNextNode` garantit que
  deux workers n'obtiennent jamais la même tâche (CAS sur l'écriture, jamais sur le
  `SELECT`).
- **Workers parallèles** = plusieurs processus → chacun sa connexion `tracker.db`
  (WAL : lecteurs concurrents + 1 écrivain).
- **`PRAGMA busy_timeout`** : vérifier qu'il est posé à l'ouverture
  (`db/connection.js`) pour que le CAS attende au lieu d'échouer en `SQLITE_BUSY`.
- **Crash recovery** : un worker mort laisse un bail qui **expire** → tâche
  reréclamable. `renewLease` prolonge ; s'il renvoie `false`, le worker abandonne.

## 12. Phases d'implémentation

1. **Données & file (pull pur)** — migrations (3.1–3.3), `claimNextNode` /
   `renewLease` / `completeNode` / `failNode`, `db/runs.js`, barrel. Tests unitaires.
2. **MCP** — outils §7. Validés depuis une session Claude Code manuelle : « vide le
   backlog meowtrack du repo X ».
3. **Retour par fichier + revue** — `ingestRunReport`, `node_reviews`, résolution
   humaine, routes/UI « Points de revue ». C'est le cœur de la boucle de feedback.
4. **Auto-revue (§6.6)** — `autoReviewForest` (réutilise `runForestTurn` /
   `applyForestActions`), outil `meowtrack_review_auto` + route, déclenchement à la
   demande puis automatique (`review.autoReview`), boucle bornée.
5. **Config UI** — `app_settings`/overrides repo (dont `review.autoReviewPrompt`,
   éditeur de texte), routes `GET/PUT /api/settings/orchestrator`, panneau « Orchestrateur ».
6. **Dashboard exécution** — badges `run_state`, historique des runs, revue de diff.
7. **Autonomie (optionnel)** — scheduler server-side qui spawne des exécuteurs
   `claude -p` pointés sur le MCP de meowtrack (`--mcp-config`) avec outils
   d'écriture + worktree. Réutilise tout ce qui précède.

> Phases 1–4 = chaîne complète avec retour **et** auto-revue, pilotage manuel, zéro
> spawn server-side.

## 13. Tests (pattern `test/*.test.mjs`, `MEOWTRACK_NO_LISTEN=1`)

- **`node_claim.test.mjs`** : `claimNextNode` ne rend que des feuilles `active`
  débloquées ; respecte `maxAttempts` ; prérequis non-`done` jamais rendu ; deux
  claims rendent deux nœuds distincts ; bail expiré reréclamable ; nœud en `review`
  jamais rendu.
- **`node_complete.test.mjs`** : `completeNode` met `status='done'`, fait remonter la
  progression, débloque un dépendant ; clôture par un non-détenteur → `lease_lost` ;
  `hasBlockingReview` → `review` (pas de déblocage).
- **`run_report.test.mjs`** : ingestion fail-closed (JSON malformé → 0 action) ;
  `nodeUpdates` non destructifs appliqués selon `autoApplyUpdates` ; un `nodeUpdate`
  destructif → proposition (pas appliqué) ; `reviewPoints` persistés ; un point
  bloquant met la tâche en revue ; sa résolution promeut `review → done`.
- **`auto_review.test.mjs`** : le message synthétique met le bloc de revue en
  *untrusted* et la politique en consigne ; un tour produisant des actions non
  destructives réorganise l'arbre (via `applyForestActions`) et résout les points ;
  une action destructive reste **proposée** (pas appliquée) ; le compteur d'auto-revue
  plafonné bascule en revue humaine (pas de boucle infinie).
- Étendre `node_links.test.mjs` : cycle toujours refusé (terminaison du « pique une
  feuille débloquée »).

## 14. Déploiement (`deploy.sh`)

- `mcp.js` et les modules `db/` sont déjà copiés (`db/` récursif) → `db/runs.js` :
  **aucune** édition d'allowlist.
- Un nouveau module **racine** (ex. scheduler `orchestrator.js`, phase 7) doit être
  **ajouté à `FILES`**, sinon `ERR_MODULE_NOT_FOUND` au boot.
- Un nouveau `dashboard/*.js` → l'ajouter à `DASHBOARD_FILES`.
- `.meowtrack/runs/` vit dans les repos de travail (clones), pas dans le code
  meowtrack — rien à copier.

## 15. Variables d'environnement (défauts, surchargés par l'UI — §5)

| Var | Défaut | Rôle |
| --- | --- | --- |
| `MEOWTRACK_RUN_LEASE_MS` | `600000` | Durée d'un bail (10 min) |
| `MEOWTRACK_RUN_MAX_ATTEMPTS` | `3` | Retries avant `failed` |
| `MEOWTRACK_RUN_PARALLEL` | `1` | (phase 7) exécuteurs simultanés par repo |
| `MEOWTRACK_RUN_BRANCH_PREFIX` | `meow/` | Préfixe des branches de travail |
| `MEOWTRACK_RUN_AUTOAPPLY` | `0` | Auto-applique les `nodeUpdates` non destructifs |
| `MEOWTRACK_REVIEW_AUTO` | `0` | Auto-revue par le chat IA top-level sur point de revue (§6.6) |
| `MEOWTRACK_REVIEW_AUTO_PROMPT` | — | Prompt de politique d'auto-revue (préféré : via l'UI) |

> Ces variables sont les **défauts de bootstrap** ; la valeur effective vient de
> `app_settings` / override repo dès qu'elle est définie dans l'interface (§5.1).

## 16. Décisions ouvertes

- **Prérequis sur jalon** : auto-promotion à `done` (recommandé, §4.5) vs explicite.
- **Commande de test** : stockée par repo dans `run.testCommand` (§5.2) — qui la
  définit, et que faire si `testResult='fail'` (auto-`fail` + retry ?).
- **Granularité « exécutable »** : feuilles uniquement (proposé) vs jalon composite.
- **Sort du fichier rapport** : conservé sur la branche (auditable) vs archivé/supprimé.
- **Auto-revue** : destructif toujours en confirmation (proposé) même en auto, ou
  auto-apply complet sous flag explicite ? Plafond d'auto-revues avant bascule humaine ?
- **Autonomie** : pilotage manuel/`/loop` (simple) vs scheduler server-side (phase 7).

---

*Récapitulatif : ~4 colonnes + 2 tables + primitives data + 7 outils MCP. Le tri
topo n'existe pas (il émerge). L'exclusivité tient en une instruction SQL. La boucle
de feedback passe par un fichier `.meowtrack/runs/<ref>.json` ingéré côté serveur,
qui applique les retours via le catalogue d'actions sûr et lève des points de revue.
Ces points sont résolus par un humain **ou** en auto-revue par le chat IA top-level
(réutilise `runForestTurn`/`applyForestActions`), guidée par un prompt de politique
préparé d'avance. La config est éditable dans l'interface (app_settings + overrides repo).*
