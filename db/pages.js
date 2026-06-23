// db/pages.js — CRUD des PAGES DE GRAPHE (NODE-337, Option B = appartenance EXCLUSIVE).
//
// Une « page » est une toile séparée regroupant des nœuds : un nœud appartient à UNE
// seule page, et un arbre entier partage la page de sa RACINE (hypothèse de travail
// « par racine »). Une page `is_default` par dépôt absorbe les nœuds non rattachés
// (jamais d'état invalide). Per-dépôt : une table `graph_pages` par tracker.db, routée
// par withRepo (patron chat_sessions / chat_templates).
//
// L'assignation à la CRÉATION/au DÉPLACEMENT d'un nœud vit dans ./nodes.js (héritage de
// la page du parent / de la racine) ; ici on gère le cycle de vie des pages + le
// rattachement explicite d'un sous-arbre (setNodePage).

import { db, withRepo } from "./connection.js";
import { clampStr } from "./helpers.js";

const MAX_NAME = 120;
const MAX_PREPROMPT = 100000;

function rowToPage(r, nodeCount) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    position: r.position,
    templateId: r.template_id != null ? r.template_id : null,
    preprompt: r.preprompt || "",
    isDefault: !!r.is_default,
    createdAt: r.created_at,
    ...(nodeCount != null ? { nodeCount } : {}),
  };
}

const normName = (name) => clampStr(String(name || "").trim() || "Sans titre", MAX_NAME);

// Page par défaut du dépôt (créée à la volée si absente) — absorbe les nœuds orphelins.
export function ensureDefaultPage(repoId = null) {
  return withRepo(repoId, () => {
    let r = db.prepare("SELECT * FROM graph_pages WHERE is_default = 1 ORDER BY id LIMIT 1").get();
    if (!r) {
      const res = db.prepare("INSERT INTO graph_pages(name, position, is_default) VALUES('Principale', 0, 1)").run();
      r = db.prepare("SELECT * FROM graph_pages WHERE id = ?").get(Number(res.lastInsertRowid));
    }
    return rowToPage(r);
  });
}

export function listPages(repoId = null) {
  return withRepo(repoId, () => {
    ensureDefaultPageInline();
    return db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM nodes n WHERE n.page_id = p.id) AS node_count
         FROM graph_pages p ORDER BY p.position, p.id`
      )
      .all()
      .map((r) => rowToPage(r, r.node_count));
  });
}

export function getPage(id, repoId = null) {
  return withRepo(repoId, () => {
    const r = db.prepare("SELECT * FROM graph_pages WHERE id = ?").get(Number(id));
    if (!r) return null;
    const c = db.prepare("SELECT COUNT(*) c FROM nodes WHERE page_id = ?").get(r.id).c;
    return rowToPage(r, c);
  });
}

export function createPage(repoId, { name, position, templateId, preprompt } = {}) {
  return withRepo(repoId, () => {
    const pos = Number.isFinite(position)
      ? position
      : db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM graph_pages").get().p;
    const res = db
      .prepare("INSERT INTO graph_pages(name, position, template_id, preprompt, is_default) VALUES(?,?,?,?,0)")
      .run(normName(name), pos, templateId != null ? Number(templateId) : null, clampStr(preprompt || "", MAX_PREPROMPT));
    return getPage(Number(res.lastInsertRowid), repoId);
  });
}

// Mise à jour partielle (name / position / templateId / preprompt). `is_default` n'est
// PAS éditable ici (une seule page par défaut, posée à la création de la base).
export function updatePage(id, { name, position, templateId, preprompt } = {}, repoId = null) {
  return withRepo(repoId, () => {
    const sets = [];
    const vals = [];
    if (name != null) { sets.push("name = ?"); vals.push(normName(name)); }
    if (Number.isFinite(position)) { sets.push("position = ?"); vals.push(position); }
    if (templateId !== undefined) { sets.push("template_id = ?"); vals.push(templateId != null ? Number(templateId) : null); }
    if (preprompt != null) { sets.push("preprompt = ?"); vals.push(clampStr(preprompt, MAX_PREPROMPT)); }
    if (sets.length) db.prepare(`UPDATE graph_pages SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Number(id));
    return getPage(id, repoId);
  });
}

// Supprime une page et RÉATTACHE ses nœuds à la page par défaut (jamais d'orphelin).
// La page par défaut elle-même est INDESTRUCTIBLE (renvoie { ok:false, reason }).
export function deletePage(id, repoId = null) {
  return withRepo(repoId, () => {
    const r = db.prepare("SELECT * FROM graph_pages WHERE id = ?").get(Number(id));
    if (!r) return { ok: false, reason: "introuvable" };
    if (r.is_default) return { ok: false, reason: "page_par_defaut" };
    const def = ensureDefaultPageInline();
    const tx = db.transaction(() => {
      const moved = db.prepare("UPDATE nodes SET page_id = ? WHERE page_id = ?").run(def, Number(id)).changes;
      db.prepare("DELETE FROM graph_pages WHERE id = ?").run(Number(id));
      return moved;
    });
    return { ok: true, reattached: tx() };
  });
}

// Rattache un nœud (et tout son SOUS-ARBRE) à une page — appartenance par racine. Pour
// rester cohérent (un arbre = une page), on déplace le sous-arbre du nœud cible entier.
export function setNodePage(nodeId, pageId, repoId = null) {
  return withRepo(repoId, () => {
    const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(Number(nodeId));
    if (!node) throw new Error(`Nœud introuvable : ${nodeId}`);
    const page = db.prepare("SELECT id FROM graph_pages WHERE id = ?").get(Number(pageId));
    if (!page) throw new Error(`Page introuvable : ${pageId}`);
    const n = db.prepare("UPDATE nodes SET page_id = ? WHERE path LIKE ?").run(page.id, node.path + "%").changes;
    return { ok: true, updated: n };
  });
}

// Variante non-withRepo pour usage interne (déjà dans une portée withRepo).
function ensureDefaultPageInline() {
  let r = db.prepare("SELECT id FROM graph_pages WHERE is_default = 1 ORDER BY id LIMIT 1").get();
  if (!r) {
    const res = db.prepare("INSERT INTO graph_pages(name, position, is_default) VALUES('Principale', 0, 1)").run();
    r = { id: Number(res.lastInsertRowid) };
  }
  return r.id;
}
