// db/migrations.js — bootstrap + migrations one-shot exécutées au démarrage.
//
// Toutes idempotentes et best-effort : bootstrap du repo par défaut (registre
// vide), normalisation mono-repo → repo_id sur la base legacy, puis scission de la
// base legacy centrale vers un tracker.db PAR dépôt. `initDb()` enchaîne les trois
// dans l'ordre et est appelée UNE fois par le barrel db.js après chargement des
// modules (garantit que le schéma de registre et les connexions sont prêts).

import { registry, DB_PATH, db, withRepo, trackDbFor, hasTable, tableHasColumn } from "./connection.js";
import { getSetting, setSetting, deriveSlug } from "./registry.js";

// Crée le repo par défaut (depuis l'env) si le REGISTRE est vide.
function bootstrapDefaultRepo() {
  if (registry.prepare("SELECT COUNT(*) c FROM repos").get().c > 0) return;
  const url = (process.env.MEOWTRACK_REPO_URL || "").trim() || null;
  const localPath = (process.env.MEOWTRACK_REPO || "").trim() || null;
  const slug = deriveSlug(url) || "default";
  registry
    .prepare("INSERT INTO repos(slug, name, url, local_path, default_branch, is_default) VALUES(?,?,?,?,?,1)")
    .run(slug, slug, url, localPath, null);
}

// Garantit que chaque compteur (repo, préfixe) du tracker COURANT est ≥ au plus
// grand suffixe des refs existants — anti-collision de `nextRef` après import /
// migration (counters absente ou en retard). S'exécute DANS une portée withRepo.
function reconcileCounters(repoId) {
  const upsertMax = db.prepare(
    "INSERT INTO counters(repo_id, prefix, value) VALUES(?,?,?) ON CONFLICT(repo_id, prefix) DO UPDATE SET value = MAX(value, excluded.value)"
  );
  const bump = (rows) => {
    const max = {};
    for (const r of rows) {
      const mm = String(r.ref).match(/^([A-Z]+)-(\d+)$/);
      if (!mm) continue;
      const p = mm[1];
      const n = Number(mm[2]);
      if (!(p in max) || n > max[p]) max[p] = n;
    }
    for (const [p, n] of Object.entries(max)) upsertMax.run(repoId, p, n);
  };
  bump(db.prepare("SELECT ref FROM issues WHERE repo_id = ?").all(repoId));
  bump(db.prepare("SELECT ref FROM nodes WHERE repo_id = ?").all(repoId));
}

// ── Normalisation mono-repo → repo_id SUR LA BASE LEGACY (= fichier de registre) ─
// N'agit QUE si la base de registre contient encore les anciennes tables de
// tracking (instance d'avant la séparation par dépôt) sans colonne repo_id. Ajoute
// repo_id pour que `splitLegacyToTrackers` puisse filtrer par dépôt. Idempotente.
function migrateLegacyMultiRepo() {
  if (!hasTable(registry, "issues")) return;
  const defaultId =
    registry.prepare("SELECT id FROM repos WHERE is_default = 1").get()?.id ||
    registry.prepare("SELECT id FROM repos ORDER BY id LIMIT 1").get()?.id;
  if (defaultId == null) return;
  const needIssues = hasTable(registry, "issues") && !tableHasColumn(registry, "issues", "repo_id");
  const needNodes = hasTable(registry, "nodes") && !tableHasColumn(registry, "nodes", "repo_id");
  const needCounters = hasTable(registry, "counters") && !tableHasColumn(registry, "counters", "repo_id");
  if (!needIssues && !needNodes && !needCounters) return;

  registry.pragma("foreign_keys = OFF");
  registry.transaction(() => {
    if (needIssues) {
      registry.exec(`
        CREATE TABLE issues_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, ref TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'bug', title TEXT NOT NULL, description TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'medium',
          tags TEXT NOT NULL DEFAULT '[]', branch TEXT, git_commit TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          UNIQUE(repo_id, ref)
        );`);
      registry
        .prepare(
          `INSERT INTO issues_new (id, repo_id, ref, type, title, description, status, priority, tags, branch, git_commit, created_at, updated_at)
           SELECT id, ?, ref, type, title, description, status, priority, tags, branch, git_commit,
                  COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')), COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')) FROM issues`
        )
        .run(defaultId);
      registry.exec("DROP TABLE issues; ALTER TABLE issues_new RENAME TO issues;");
    }
    if (needNodes) {
      registry.exec(`
        CREATE TABLE nodes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, ref TEXT NOT NULL,
          parent_id INTEGER, root_id INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 0,
          path TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
          color TEXT NOT NULL DEFAULT 'accent', emoji TEXT NOT NULL DEFAULT '🎯', target_date TEXT,
          progress INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, pos_x REAL, pos_y REAL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), done_at TEXT,
          CHECK (parent_id IS NULL OR parent_id <> id), UNIQUE(repo_id, ref),
          FOREIGN KEY(parent_id) REFERENCES nodes(id) ON DELETE CASCADE
        );`);
      registry
        .prepare(
          `INSERT INTO nodes_new (id, repo_id, ref, parent_id, root_id, depth, path, title, description, notes, status, color, emoji, target_date, progress, position, pos_x, pos_y, version, created_at, updated_at, done_at)
           SELECT id, ?, ref, parent_id, root_id, depth, path, title, description, notes, status, color, emoji, target_date, progress, position, pos_x, pos_y, version,
                  COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')), COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')), done_at FROM nodes`
        )
        .run(defaultId);
      registry.exec("DROP TABLE nodes; ALTER TABLE nodes_new RENAME TO nodes;");
    }
    if (needCounters) {
      registry.exec(`
        CREATE TABLE counters_new (
          repo_id INTEGER NOT NULL, prefix TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (repo_id, prefix)
        );`);
      registry.prepare("INSERT INTO counters_new (repo_id, prefix, value) SELECT ?, prefix, value FROM counters").run(defaultId);
      registry.exec("DROP TABLE counters; ALTER TABLE counters_new RENAME TO counters;");
    }
  })();
  registry.pragma("foreign_keys = ON");
}

// ── Scission de la base LEGACY (registre) → une base tracker.db PAR dépôt ──────
// Pour chaque dépôt, copie ses données de tracking depuis l'ancienne base centrale
// vers son `tracker.db` (ids PRÉSERVÉS) via ATTACH. Idempotente : drapeau global +
// trackers déjà peuplés ignorés. Les tables legacy du registre sont CONSERVÉES
// (sauvegarde — jamais droppées). Colonnes ÉNUMÉRÉES (pas de SELECT *) car les
// ALTER ADD COLUMN historiques ont pu changer l'ordre des colonnes legacy.
const COLS = {
  issues: "id, repo_id, ref, type, title, description, status, priority, tags, branch, git_commit, created_at, updated_at",
  refs: "id, issue_id, path, kind, line_start, line_end, existed, created_at",
  comments: "id, issue_id, body, created_at",
  counters: "repo_id, prefix, value",
  nodes:
    "id, repo_id, ref, parent_id, root_id, depth, path, title, description, notes, status, color, emoji, target_date, progress, position, pos_x, pos_y, version, created_at, updated_at, done_at",
  node_messages: "id, node_id, role, author, model, body, reasoning, state, actions, client_nonce, created_at",
  forest_messages: "id, repo_id, role, author, model, body, reasoning, state, actions, client_nonce, created_at",
};
function splitLegacyToTrackers() {
  if (!hasTable(registry, "issues")) return; // base déjà « registre seul »
  if (getSetting("tracking_split_done") === "1") return; // déjà scindée
  for (const r of registry.prepare("SELECT id FROM repos").all()) {
    const rid = r.id;
    const conn = trackDbFor(rid);
    const already = conn.prepare("SELECT COUNT(*) c FROM issues").get().c + conn.prepare("SELECT COUNT(*) c FROM nodes").get().c;
    if (already > 0) continue; // tracker non vide : ne pas écraser
    conn.prepare("ATTACH DATABASE ? AS legacy").run(DB_PATH);
    // Copie une table legacy → tracker (colonnes énumérées, clause WHERE paramétrée
    // par rid). Tolérante : une table legacy absente/incompatible n'échoue pas tout.
    const TS = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
    const copy = (table, whereSql) => {
      try {
        // created_at/updated_at sont NOT NULL côté tracker → COALESCE defensif
        // (données legacy théoriquement non nulles, mais on ne casse pas la copie).
        const sel = COLS[table]
          .split(", ")
          .map((c) => (c === "created_at" || c === "updated_at" ? `COALESCE(${c}, ${TS})` : c))
          .join(", ");
        conn.prepare(`INSERT INTO main.${table} (${COLS[table]}) SELECT ${sel} FROM legacy.${table} WHERE ${whereSql}`).run(rid);
      } catch (e) {
        console.error(`[meowtrack] split ${table} (repo ${rid}) : ${e.message || e}`);
      }
    };
    try {
      conn.transaction(() => {
        copy("issues", "repo_id = ?");
        copy("refs", "issue_id IN (SELECT id FROM legacy.issues WHERE repo_id = ?)");
        copy("comments", "issue_id IN (SELECT id FROM legacy.issues WHERE repo_id = ?)");
        copy("counters", "repo_id = ?");
        copy("nodes", "repo_id = ?");
        copy("node_messages", "node_id IN (SELECT id FROM legacy.nodes WHERE repo_id = ?)");
        copy("forest_messages", "repo_id = ?");
      })();
    } finally {
      conn.prepare("DETACH DATABASE legacy").run();
    }
    withRepo(rid, () => reconcileCounters(rid)); // compteurs ≥ refs importés
  }
  setSetting("tracking_split_done", "1");
}

// Séquence d'initialisation (appelée une fois par db.js après chargement).
export function initDb() {
  bootstrapDefaultRepo();
  migrateLegacyMultiRepo();
  splitLegacyToTrackers();
}
