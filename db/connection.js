// db/connection.js — fondation de persistance : connexion de REGISTRE + pool de
// connexions « tracker.db » par dépôt + proxy ambiant `db` routé par withRepo.
//
// Source de vérité du schéma. better-sqlite3 synchrone, WAL, migrations additives
// idempotentes. La base `meowtrack.db` (registre) vit à la RACINE du dépôt
// meowtrack (à côté de package.json) et est gitignorée (locale par machine) ; les
// DONNÉES de tracking vivent dans un `tracker.db` PAR dépôt (cf. repos.js).
//
// Import circulaire SÛR avec ./registry.js (resolveRepoId) et ../repos.js
// (trackerDbPathFor) : utilisés uniquement dans le corps des fonctions, jamais à
// l'évaluation du module. Le code d'évaluation (création du registre + schéma)
// n'utilise que des symboles locaux.

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackerDbPathFor } from "../repos.js";
import { resolveRepoId } from "./registry.js";
import { PREFIX } from "./constants.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // …/meowtrack/db
// Base de REGISTRE (par machine, gitignorée) : UNIQUEMENT le registre des dépôts
// (`repos`) et les réglages d'instance (`app_settings`). Résolue à la racine du
// dépôt meowtrack (un niveau au-dessus de ce fichier db/).
export const DB_PATH = process.env.MEOWTRACK_DB || join(HERE, "..", "meowtrack.db");

// ── Migrations additives idempotentes (colonnes ajoutées sur bases existantes) ─
// Paramétrées par connexion : appliquées au tracker COURANT (ensureTrackerSchema)
// ou à la base de registre/legacy. `db` étant un proxy (pas une connexion), ces
// helpers prennent `conn` explicitement.
export function ensureColumn(conn, table, column, ddl) {
  const cols = conn.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
export function tableHasColumn(conn, table, column) {
  return conn.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
export function hasTable(conn, name) {
  return !!conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

export const registry = new Database(DB_PATH);
registry.pragma("journal_mode = WAL");
registry.pragma("synchronous = NORMAL");
registry.pragma("foreign_keys = ON");
registry.exec(`
  CREATE TABLE IF NOT EXISTS repos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    slug          TEXT UNIQUE NOT NULL,                 -- identifiant court stable (ex: 'meownopoly')
    name          TEXT NOT NULL,                        -- libellé affiché
    url           TEXT,                                 -- URL git de clone (null = clone géré à la main / dev in-repo)
    local_path    TEXT,                                 -- override du chemin de clone (sinon .repos/<slug>/)
    default_branch TEXT,                                -- branche par défaut (autocomplete / contexte)
    is_default    INTEGER NOT NULL DEFAULT 0,           -- repo utilisé quand le paramètre repo est omis
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  -- Réglages globaux de l'instance (clé/valeur), ex. github_client_id éditable via l'UI.
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);
// Migration additive idempotente : liste JSON des branches masquées par dépôt
// (sélecteurs de branche, autocomplete « @ »). La branche de suivi est toujours
// masquée par défaut côté repos.js, sans figurer dans cette liste.
ensureColumn(registry, "repos", "hidden_branches", "hidden_branches TEXT NOT NULL DEFAULT '[]'");

// Horodatage indépendant de la connexion tracker → registre (toujours disponible,
// même hors portée withRepo).
export function nowIso() {
  return registry.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS t").get().t;
}

// ── Pool de connexions « tracker.db » par dépôt + connexion AMBIANTE ──────────
// Une base SQLite PAR dépôt (cloisonnement total + versionnement git). Toutes les
// requêtes de tracking passent par le proxy `db`, qui route vers la base du dépôt
// COURANT — fixé à l'entrée de chaque fonction publique via withRepo(repoId, …).
// Un arbre / une issue ne traverse jamais 2 dépôts : la connexion est donc stable
// pendant toute une opération (transactions + sous-appels synchrones inclus).
const _pool = new Map(); // repoId → Database (tracker.db)
let _cx = null;          // connexion tracker active (ambiante)

function cx() {
  if (!_cx) throw new Error("Aucune connexion de dépôt active (withRepo manquant)");
  return _cx;
}
// Proxy minimal : on conserve le nom `db` pour que les corps de fonctions de
// tracking restent INCHANGÉS (db.prepare/exec/pragma/transaction → dépôt courant).
export const db = {
  prepare: (sql) => cx().prepare(sql),
  exec: (sql) => cx().exec(sql),
  pragma: (p, o) => cx().pragma(p, o),
  transaction: (fn) => cx().transaction(fn),
};

// ── Schéma des bases « tracker.db » (une par dépôt, sans table `repos`) ────────
// repo_id est conservé (constant dans une base) pour limiter les changements de
// requêtes, mais les FK vers `repos` sont retirées (la table n'existe pas ici).
export const TRACKING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS issues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id     INTEGER NOT NULL,
    ref         TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'bug',
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open',
    priority    TEXT NOT NULL DEFAULT 'medium',
    tags        TEXT NOT NULL DEFAULT '[]',
    branch      TEXT,
    git_commit  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(repo_id, ref)
  );

  CREATE TABLE IF NOT EXISTS refs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id    INTEGER NOT NULL,
    path        TEXT NOT NULL,
    kind        TEXT,
    line_start  INTEGER,
    line_end    INTEGER,
    existed     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_refs_issue ON refs(issue_id);

  CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id    INTEGER NOT NULL,
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);

  CREATE TABLE IF NOT EXISTS counters (
    repo_id INTEGER NOT NULL,
    prefix  TEXT NOT NULL,
    value   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repo_id, prefix)
  );

  -- ── Vibes v2 : arbre de NŒUDS récursif (objectifs = jalons = sous-jalons) ─
  -- v1 (goals/milestones) jamais déployée → on remplace sans migration.
  DROP TABLE IF EXISTS goal_messages;
  DROP TABLE IF EXISTS milestones;
  DROP TABLE IF EXISTS goals;

  CREATE TABLE IF NOT EXISTS nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id     INTEGER NOT NULL,                     -- repo de rattachement (un arbre ne traverse jamais 2 repos)
    ref         TEXT NOT NULL,                        -- NODE-1… via nextRef(repoId,'node'), unique PAR repo
    parent_id   INTEGER,                              -- NULL = racine ; self-FK ON DELETE CASCADE
    root_id     INTEGER NOT NULL,                     -- racine de l'arbre (= id si racine)
    depth       INTEGER NOT NULL DEFAULT 0,           -- 0 = racine
    path        TEXT NOT NULL DEFAULT '',             -- '/1/4/9/' ids ancêtres + self → subtree via LIKE
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',             -- notes libres markdown (rendu côté dashboard)
    status      TEXT NOT NULL DEFAULT 'active',       -- active|paused|done|abandoned
    color       TEXT NOT NULL DEFAULT 'accent',       -- accent|feature|task|bug|high (allowlist)
    emoji       TEXT NOT NULL DEFAULT '🎯',
    target_date TEXT,                                 -- 'YYYY-MM-DD' | null
    progress    INTEGER NOT NULL DEFAULT 0,           -- 0..100 STOCKÉ (rollup ascendant)
    position    INTEGER NOT NULL DEFAULT 0,           -- ordre parmi frères
    pos_x       REAL,                                 -- position manuelle graphe (drag & drop), NULL = auto
    pos_y       REAL,
    version     INTEGER NOT NULL DEFAULT 1,           -- pivot CAS, bumpé soi + ancêtres
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    done_at     TEXT,
    CHECK (parent_id IS NULL OR parent_id <> id),     -- anti auto-parent direct
    UNIQUE(repo_id, ref),
    FOREIGN KEY(parent_id) REFERENCES nodes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, position, id);
  CREATE INDEX IF NOT EXISTS idx_nodes_root   ON nodes(root_id);
  CREATE INDEX IF NOT EXISTS idx_nodes_path   ON nodes(path);
  CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);

  CREATE TABLE IF NOT EXISTS node_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id      INTEGER NOT NULL,
    role         TEXT NOT NULL,                        -- user|assistant
    author       TEXT NOT NULL DEFAULT 'anon',
    model        TEXT,                                 -- sonnet|opus|haiku | null
    body         TEXT NOT NULL DEFAULT '',             -- réponse finale (SANS bloc d'actions)
    reasoning    TEXT NOT NULL DEFAULT '',             -- réflexion streamée (repliable)
    state        TEXT NOT NULL DEFAULT 'complete',     -- pending|streaming|complete|error
    actions      TEXT NOT NULL DEFAULT '[]',           -- JSON audit (appliquées/proposées)
    client_nonce TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_node_messages_node ON node_messages(node_id, id);

  -- Liens de PRÉREQUIS entre nœuds (graphe additif, hors hiérarchie). from_id =
  -- le dépendant, to_id = le prérequis (« from dépend de to »). N'affecte NI le
  -- path/depth NI la progression — purement visuel + signal de blocage. Les deux
  -- extrémités vivent dans la MÊME base tracker (un lien ne traverse jamais 2 repos,
  -- structurellement). Cascade : supprimer un nœud purge ses liens (entrants+sortants).
  CREATE TABLE IF NOT EXISTS node_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id    INTEGER NOT NULL,                      -- le dépendant
    to_id      INTEGER NOT NULL,                      -- le prérequis
    kind       TEXT NOT NULL DEFAULT 'requires',      -- type de lien (allowlist)
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    CHECK (from_id <> to_id),                          -- anti auto-lien
    UNIQUE(from_id, to_id, kind),
    FOREIGN KEY(from_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(to_id)   REFERENCES nodes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_node_links_from ON node_links(from_id);
  CREATE INDEX IF NOT EXISTS idx_node_links_to   ON node_links(to_id);

  -- Chat « top level » d'un repo : discussion globale avec l'IA pour créer/gérer
  -- les objectifs racines (pas d'ancrage à un nœud précis ; scope = repo entier).
  CREATE TABLE IF NOT EXISTS forest_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id      INTEGER NOT NULL,
    role         TEXT NOT NULL,                        -- user|assistant
    author       TEXT NOT NULL DEFAULT 'anon',
    model        TEXT,                                 -- sonnet|opus|haiku | null
    body         TEXT NOT NULL DEFAULT '',             -- réponse finale (SANS bloc d'actions)
    reasoning    TEXT NOT NULL DEFAULT '',             -- réflexion streamée (repliable)
    state        TEXT NOT NULL DEFAULT 'complete',     -- pending|streaming|complete|error
    actions      TEXT NOT NULL DEFAULT '[]',           -- JSON audit (appliquées/proposées)
    client_nonce TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_forest_messages_repo ON forest_messages(repo_id, id);

  -- ── Orchestrateur : historique d'exécution d'un nœud (un run = un passage agent).
  CREATE TABLE IF NOT EXISTS node_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL,
    owner       TEXT,                                 -- worker détenteur du bail
    state       TEXT NOT NULL,                        -- running|done|review|failed
    branch      TEXT,                                 -- branche de travail (ex. meow/NODE-12)
    summary     TEXT,                                 -- compte-rendu de l'agent
    error       TEXT,                                 -- message d'échec
    test_result TEXT,                                 -- pass|fail|skipped|NULL
    report      TEXT,                                 -- JSON brut du fichier .meowtrack/runs/<ref>.json
    started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    ended_at    TEXT,
    FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_node_runs_node ON node_runs(node_id, id);

  -- ── Orchestrateur : points de revue soulevés par l'agent (canal de feedback).
  CREATE TABLE IF NOT EXISTS node_reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL,
    run_id      INTEGER,                              -- run d'origine (SET NULL si purgé)
    kind        TEXT NOT NULL,                        -- decision|question|risk|discovery
    message     TEXT NOT NULL,                        -- le point soulevé
    blocking    INTEGER NOT NULL DEFAULT 0,           -- 1 = bloque la complétion du nœud
    suggested   TEXT,                                 -- JSON : actions proposées (catalogue applyNodeActions)
    state       TEXT NOT NULL DEFAULT 'open',         -- open|resolved|dismissed
    response    TEXT,                                 -- réponse (humain ou auto-revue)
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    resolved_at TEXT,
    FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(run_id)  REFERENCES node_runs(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_node_reviews_open ON node_reviews(node_id, state);
`;

function ensureTrackerSchema(conn) {
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("foreign_keys = ON");
  // Plusieurs workers d'exécution (processus distincts) peuvent contendre sur la
  // même base lors du compare-and-swap de claimNextNode : busy_timeout fait ATTENDRE
  // l'écrivain au lieu d'échouer en SQLITE_BUSY (cf. orchestrateur, §11 concurrence).
  conn.pragma("busy_timeout = 5000");
  conn.exec(TRACKING_SCHEMA);
  // Migrations additives idempotentes (bases tracker antérieures aux colonnes).
  ensureColumn(conn, "nodes", "notes", "notes TEXT NOT NULL DEFAULT ''");
  ensureColumn(conn, "nodes", "pos_x", "pos_x REAL");
  ensureColumn(conn, "nodes", "pos_y", "pos_y REAL");
  // Orchestrateur : bail (lease) d'exécution sur les nœuds. Séparé de `status`
  // (intention de planning) ; coordonne les workers concurrents (cf. db/nodes.js).
  ensureColumn(conn, "nodes", "run_state", "run_state TEXT");                       // NULL|running|review|failed (done = miroir status)
  ensureColumn(conn, "nodes", "lease_owner", "lease_owner TEXT");                   // worker détenteur
  ensureColumn(conn, "nodes", "lease_until", "lease_until TEXT");                   // ISO : expiration du bail
  ensureColumn(conn, "nodes", "run_attempts", "run_attempts INTEGER NOT NULL DEFAULT 0");
  ensureColumn(conn, "nodes", "auto_reviews", "auto_reviews INTEGER NOT NULL DEFAULT 0"); // compteur d'auto-revues (anti-boucle)
}

export function trackDbFor(repoId) {
  let conn = _pool.get(repoId);
  if (conn) return conn;
  const path = trackerDbPathFor(repoId); // crée le dossier au besoin (repos.js)
  conn = new Database(path);
  ensureTrackerSchema(conn);
  _pool.set(repoId, conn);
  return conn;
}
// Ferme et oublie la connexion d'un dépôt (suppression de dépôt).
export function closeTrackerDb(repoId) {
  const conn = _pool.get(repoId);
  if (conn) {
    try { conn.close(); } catch { /* ignore */ }
    _pool.delete(repoId);
  }
}
// Rapatrie le WAL dans le fichier principal tracker.db (checkpoint TRUNCATE) avant
// un commit git : garantit que le fichier versionné reflète TOUT l'état committé
// (sinon des frames récentes resteraient dans le -wal, non capturées). No-op si la
// connexion n'est pas (encore) ouverte. `repoId` peut être un id ou un slug.
export function checkpointTracker(repoId) {
  let id;
  try {
    id = resolveRepoId(repoId);
  } catch {
    return;
  }
  const conn = _pool.get(id);
  if (!conn) return;
  try {
    conn.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* ignore (checkpoint best-effort) */
  }
}

// Fixe la connexion ambiante sur le dépôt voulu pendant l'exécution de `fn`.
// repoId null → si déjà dans une portée on HÉRITE (sous-appel même dépôt), sinon
// dépôt par défaut. Réentrant (sauvegarde/restaure), sûr car tout est synchrone.
export function withRepo(repoId, fn) {
  const target = repoId != null ? trackDbFor(resolveRepoId(repoId)) : _cx || trackDbFor(resolveRepoId(null));
  const prev = _cx;
  _cx = target;
  try {
    return fn();
  } finally {
    _cx = prev;
  }
}

// Code lisible suivant `BUG-1`, `FEAT-2`… Un compteur monotone PAR (repo, préfixe)
// — pas de réutilisation après suppression. Chaque repo a sa propre série. Opère
// sur le tracker COURANT (proxy `db`) → à appeler dans une portée withRepo.
export function nextRef(repoId, type) {
  const prefix = PREFIX[type] || "ISSUE";
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO counters(repo_id, prefix, value) VALUES(?, ?, 0) ON CONFLICT(repo_id, prefix) DO NOTHING").run(repoId, prefix);
    db.prepare("UPDATE counters SET value = value + 1 WHERE repo_id = ? AND prefix = ?").run(repoId, prefix);
    return db.prepare("SELECT value FROM counters WHERE repo_id = ? AND prefix = ?").get(repoId, prefix).value;
  });
  return `${prefix}-${tx()}`;
}
