// db/nodes.js — Vibes v2 : arbre de NŒUDS récursif + application des actions
// IA (catalogue fermé scopé sous-arbre / repo).
//
// Un seul type de nœud (objectif = jalon = sous-jalon), `parent_id` self-réf.
// `path` ('/1/4/9/' ids ancêtres + self) rend subtree/ancestors/scope O(1) en SQL
// pur (LIKE). `progress` (0..100) est STOCKÉ et recalculé en remontant la chaîne
// d'ancêtres à chaque mutation (recomputeAncestorProgress). `version` par nœud =
// pivot de concurrence (bumpé sur le nœud + ses ancêtres).
//
// MULTI-REPOS : chaque nœud porte `repo_id` (un arbre ne traverse jamais 2 repos —
// move inter-repo refusé). Les ids étant globaux (PK), les lectures par id n'exigent
// pas de repo ; seules les résolutions par CODE (NODE-1) exigent un repoId.
//
// Cycle ESM SÛR avec ./messages.js (getNode → listNodeMessages ; messages →
// findNodeRow) : usages en corps de fonction uniquement.

import { db, withRepo, nowIso, nextRef } from "./connection.js";
import { resolveRepoId } from "./registry.js";
import {
  NODE_STATUS_SET,
  NODE_KIND_SET,
  NODE_COLOR_SET,
  NODE_LINK_KIND_SET,
  MAX_DEPTH,
  MAX_NODES_PER_SUBTREE,
  MAX_NODES_PER_REPO,
  MAX_ACTIONS,
  MAX_LINKS_PER_NODE,
} from "./constants.js";
import { clampStr, clampEmoji, parseNotes, normalizeNotesInput, validDateOrNull } from "./helpers.js";
import { listNodeMessages } from "./messages.js";
import { startRun, finishRun } from "./runs.js";

// ── Sérialisation ────────────────────────────────────────────────────────────
function childCountOf(id) {
  return db.prepare("SELECT COUNT(*) c FROM nodes WHERE parent_id = ?").get(id).c;
}

function rowToNode(r, { childCount, includeNotes = true } = {}) {
  if (!r) return null;
  const pct = Math.max(0, Math.min(100, r.progress | 0));
  return {
    id: r.id,
    repoId: r.repo_id,
    ref: r.ref,
    parentId: r.parent_id,
    rootId: r.root_id,
    depth: r.depth,
    title: r.title,
    description: r.description,
    ...(includeNotes ? { notes: parseNotes(r.notes) } : {}),
    status: r.status,
    // Type de nœud : 'normal' (défaut) ou 'activation' (porte de prérequis manuelle).
    // Tolère les bases pré-migration (colonne absente → 'normal').
    kind: r.kind || "normal",
    color: r.color,
    emoji: r.emoji,
    // Info attendue de l'utilisateur (markdown) quand status='waiting' ; sinon null.
    pendingInfo: r.pending_info != null ? r.pending_info : null,
    targetDate: r.target_date,
    progress: pct,
    position: r.position,
    posX: r.pos_x != null ? r.pos_x : null,
    posY: r.pos_y != null ? r.pos_y : null,
    version: r.version,
    // Orchestrateur : état d'exécution (bail). `run_state` peut être absent sur les
    // bases pré-migration (colonne ajoutée) → null par défaut.
    runState: r.run_state != null ? r.run_state : null,
    leaseOwner: r.lease_owner != null ? r.lease_owner : null,
    leaseUntil: r.lease_until != null ? r.lease_until : null,
    runAttempts: r.run_attempts | 0,
    autoReviews: r.auto_reviews | 0,
    childCount: childCount != null ? childCount : childCountOf(r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    doneAt: r.done_at,
  };
}

// ── Primitives subtree / ancestors (via `path`, zéro CTE) ────────────────────
// Résout par id numérique (repo ignoré) ou par code (exige repoId).
export function findNodeRow(refOrId, repoId = null) {
  if (refOrId == null) return null;
  if (typeof refOrId === "number" || /^\d+$/.test(String(refOrId)))
    return db.prepare("SELECT * FROM nodes WHERE id = ?").get(Number(refOrId));
  if (repoId == null) throw new Error("repo requis pour résoudre un code de nœud");
  return db.prepare("SELECT * FROM nodes WHERE repo_id = ? AND ref = ? COLLATE NOCASE").get(repoId, String(refOrId));
}

function ancestorIds(row) {
  const ids = String(row.path || "").split("/").filter(Boolean).map(Number);
  return ids.slice(0, -1);
}

function loadSubtreeRows(rootRow) {
  return db.prepare("SELECT * FROM nodes WHERE path LIKE ? ORDER BY depth, position, id").all(rootRow.path + "%");
}

function descendantCount(row) {
  return db.prepare("SELECT COUNT(*) c FROM nodes WHERE path LIKE ?").get(row.path + "%").c - 1;
}

function isInSubtree(rootId, targetId) {
  const root = findNodeRow(rootId);
  const target = findNodeRow(targetId);
  if (!root || !target) return false;
  return target.path.startsWith(root.path);
}

function buildTree(rows, rootId) {
  const byId = new Map();
  for (const r of rows) byId.set(r.id, { ...rowToNode(r, { childCount: 0 }), children: [] });
  let root = null;
  for (const r of rows) {
    const n = byId.get(r.id);
    if (r.id === rootId) {
      root = n;
      continue;
    }
    const parent = byId.get(r.parent_id);
    if (parent) parent.children.push(n);
  }
  for (const n of byId.values()) n.childCount = n.children.length;
  return root || { children: [] };
}

// ── Lecture ──────────────────────────────────────────────────────────────────
export function getNode(refOrId, { withMessages = false, withTree = false, withLinks = false, withIssues = false, repoId = null } = {}) {
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) return null;
    const node = rowToNode(row);
    if (withTree) node.children = buildTree(loadSubtreeRows(row), row.id).children;
    if (withMessages) node.messages = listNodeMessages(row.id);
    if (withLinks) Object.assign(node, nodeLinksOf(row.id)); // { requires, requiredBy }
    if (withIssues) node.issues = nodeIssuesOf(row.id); // entrées de suivi liées
    return node;
  });
}

export function getSubtree(refOrId, { maxNodes = MAX_NODES_PER_SUBTREE, repoId = null } = {}) {
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) return null;
    const rows = loadSubtreeRows(row).slice(0, maxNodes);
    const counts = new Map();
    for (const r of rows) if (r.parent_id != null) counts.set(r.parent_id, (counts.get(r.parent_id) || 0) + 1);
    const toN = (r) => rowToNode(r, { childCount: counts.get(r.id) || 0 });
    return { node: toN(row), descendants: rows.filter((r) => r.id !== row.id).map(toN) };
  });
}

export function listRootNodes(repoId, filter = {}) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
  const where = ["parent_id IS NULL", "repo_id = ?"];
  const vals = [repoId];
  if (filter.status) {
    where.push("status = ?");
    vals.push(filter.status);
  }
  if (filter.text) {
    where.push("(title LIKE ? OR description LIKE ? OR ref LIKE ?)");
    const l = `%${filter.text}%`;
    vals.push(l, l, l);
  }
  const rows = db.prepare("SELECT * FROM nodes WHERE " + where.join(" AND ") + " ORDER BY position, id").all(...vals);
  const limit = filter.limit ? Math.max(1, Math.min(500, filter.limit)) : 200;
  return rows.slice(0, limit).map((r) => rowToNode(r));
  });
}

// Forêt entière d'un repo à plat (graphe). childCount dérivé en un passage.
export function listForest(repoId, { includeNotes = true } = {}) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
  const rows = db.prepare("SELECT * FROM nodes WHERE repo_id = ? ORDER BY depth, position, id").all(repoId);
  const counts = new Map();
  for (const r of rows) if (r.parent_id != null) counts.set(r.parent_id, (counts.get(r.parent_id) || 0) + 1);
  return rows.map((r) => rowToNode(r, { childCount: counts.get(r.id) || 0, includeNotes }));
  });
}

export function listChildren(parentRefOrId, repoId = null) {
  return withRepo(repoId, () => {
    const p = findNodeRow(parentRefOrId, repoId);
    if (!p) return [];
    return db.prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY position, id").all(p.id).map((r) => rowToNode(r));
  });
}

export function nodePathIds(refOrId, repoId = null) {
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) return [];
    return String(row.path || "").split("/").filter(Boolean).map(Number);
  });
}

// ── Rollup de progression + concurrence ──────────────────────────────────────
function recomputeAncestorProgress(nodeId, { bumpSelf = true } = {}) {
  const start = findNodeRow(nodeId);
  if (!start) return [];
  const chain = [start.id, ...ancestorIds(start).reverse()];
  const out = [];
  const ts = nowIso();
  const selKids = db.prepare("SELECT status, progress FROM nodes WHERE parent_id = ?");
  const upd = db.prepare("UPDATE nodes SET progress = ?, version = version + 1, updated_at = ? WHERE id = ?");
  // Auto-promotion d'un JALON (§4.5) : un parent dont tous les enfants sont terminés
  // (progress 100) passe lui-même 'done' → un prérequis pointant un jalon devient
  // satisfait sans clôture manuelle. Monotone (promeut jamais ne rétrograde).
  const prom = db.prepare("UPDATE nodes SET status='done', done_at=COALESCE(done_at, ?) WHERE id = ?");
  const sel = db.prepare("SELECT * FROM nodes WHERE id = ?");
  for (let i = 0; i < chain.length; i++) {
    const row = sel.get(chain[i]);
    if (!row) continue;
    const kids = selKids.all(row.id);
    let prog;
    if (kids.length) prog = Math.round(kids.reduce((a, k) => a + (k.status === "done" ? 100 : k.progress), 0) / kids.length);
    else prog = row.status === "done" ? 100 : 0;
    const promote = kids.length > 0 && prog === 100 && (row.status === "active" || row.status === "paused");
    const isSelf = i === 0;
    if ((isSelf && bumpSelf) || prog !== row.progress || promote) {
      upd.run(prog, ts, row.id);
      if (promote) prom.run(nowIso(), row.id);
      out.push(sel.get(row.id));
    } else if (isSelf) {
      out.push(row);
    }
  }
  return out;
}

// ── Helpers de mutation internes (SANS bump : l'appelant rollup ensuite) ─────
function _setNodeFields(id, fields = {}) {
  const row = db.prepare("SELECT status FROM nodes WHERE id = ?").get(id);
  if (!row) throw new Error(`Nœud introuvable : ${id}`);
  const sets = [];
  const vals = [];
  if (fields.title != null) {
    const t = String(fields.title).trim().slice(0, 200);
    if (t) {
      sets.push("title = ?");
      vals.push(t);
    }
  }
  if (fields.description != null) {
    sets.push("description = ?");
    vals.push(clampStr(fields.description, 4000));
  }
  if (fields.notes != null) {
    sets.push("notes = ?");
    vals.push(normalizeNotesInput(fields.notes));
  }
  if ("posX" in fields) {
    sets.push("pos_x = ?");
    vals.push(fields.posX == null ? null : Number(fields.posX));
  }
  if ("posY" in fields) {
    sets.push("pos_y = ?");
    vals.push(fields.posY == null ? null : Number(fields.posY));
  }
  // `pending_info` : info attendue de l'utilisateur (status='waiting'). Accepte les
  // deux casses (`pendingInfo` côté API/IA, `pending_info` brut). null/'' efface.
  const hasPending = "pendingInfo" in fields || "pending_info" in fields;
  if (fields.status != null) {
    if (!NODE_STATUS_SET.has(fields.status)) throw new Error(`Statut invalide : ${fields.status}`);
    sets.push("status = ?");
    vals.push(fields.status);
    if (fields.status === "done" && row.status !== "done") {
      sets.push("done_at = ?");
      vals.push(nowIso());
    } else if (fields.status !== "done") {
      sets.push("done_at = ?");
      vals.push(null);
    }
    // En quittant 'waiting', l'info en attente n'a plus lieu d'être → effacée
    // (sauf si l'appelant fournit explicitement une nouvelle valeur ci-dessous).
    if (fields.status !== "waiting" && row.status === "waiting" && !hasPending) {
      sets.push("pending_info = ?");
      vals.push(null);
    }
  }
  if (hasPending) {
    const pi = "pendingInfo" in fields ? fields.pendingInfo : fields.pending_info;
    sets.push("pending_info = ?");
    vals.push(pi == null || pi === "" ? null : clampStr(String(pi), 8000));
  }
  // `kind` : type de nœud (normal|activation). Permet de convertir un nœud existant
  // en node d'activation (et inversement) depuis l'édition / l'IA.
  if (fields.kind != null) {
    if (!NODE_KIND_SET.has(fields.kind)) throw new Error(`Type de nœud invalide : ${fields.kind}`);
    sets.push("kind = ?");
    vals.push(fields.kind);
  }
  if (fields.color != null) {
    if (!NODE_COLOR_SET.has(fields.color)) throw new Error(`Couleur invalide : ${fields.color}`);
    sets.push("color = ?");
    vals.push(fields.color);
  }
  if (fields.emoji != null) {
    sets.push("emoji = ?");
    vals.push(clampEmoji(fields.emoji));
  }
  if ("targetDate" in fields || "dueDate" in fields) {
    sets.push("target_date = ?");
    vals.push(validDateOrNull("targetDate" in fields ? fields.targetDate : fields.dueDate));
  }
  if (!sets.length) return 0;
  db.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return sets.length;
}

// Insère un enfant sous parentId (depth+1, root_id, path, repo_id hérités). throw>MAX_DEPTH.
function _insertChild(parentId, input = {}) {
  const parent = db.prepare("SELECT * FROM nodes WHERE id = ?").get(parentId);
  if (!parent) throw new Error("Parent introuvable");
  if (parent.depth + 1 > MAX_DEPTH) throw new Error("Profondeur maximale atteinte");
  const title = String(input.title || "").trim().slice(0, 200);
  if (!title) throw new Error("Titre de nœud requis");
  const status = NODE_STATUS_SET.has(input.status) ? input.status : "active";
  const kind = NODE_KIND_SET.has(input.kind) ? input.kind : "normal";
  const color = NODE_COLOR_SET.has(input.color) ? input.color : parent.color || "accent";
  // Un node d'activation prend ⚡ par défaut (reconnaissable) si aucun emoji fourni.
  const emoji = clampEmoji(input.emoji || (kind === "activation" ? "⚡" : ""));
  const description = clampStr(input.description != null ? input.description : input.detail || "", 4000);
  const notes = normalizeNotesInput(input.notes != null ? input.notes : "");
  const targetDate = validDateOrNull(input.targetDate != null ? input.targetDate : input.dueDate);
  const ref = nextRef(parent.repo_id, "node");
  const nextPos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM nodes WHERE parent_id = ?").get(parentId).p;
  const position = Number.isFinite(input.position) ? input.position : nextPos;
  const res = db
    .prepare(
      `INSERT INTO nodes(repo_id, ref, parent_id, root_id, depth, path, title, description, notes, status, kind, color, emoji, target_date, progress, position)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(parent.repo_id, ref, parentId, parent.root_id, parent.depth + 1, "", title, description, notes, status, kind, color, emoji, targetDate, status === "done" ? 100 : 0, position);
  const newId = Number(res.lastInsertRowid);
  db.prepare("UPDATE nodes SET path = ?, done_at = ? WHERE id = ?").run(parent.path + newId + "/", status === "done" ? nowIso() : null, newId);
  return newId;
}

// Insère un nœud RACINE (parent_id NULL, root_id=lui-même, path "/id/"). Non
// transactionnel (le caller enveloppe) — pendant de _insertChild pour les racines.
function _insertRoot(repoId, input = {}) {
  if (repoId == null) throw new Error("repoId requis pour un nœud racine");
  const title = String(input.title || "").trim().slice(0, 200);
  if (!title) throw new Error("Titre requis");
  const status = NODE_STATUS_SET.has(input.status) ? input.status : "active";
  const kind = NODE_KIND_SET.has(input.kind) ? input.kind : "normal";
  const color = NODE_COLOR_SET.has(input.color) ? input.color : "accent";
  // Un node d'activation prend ⚡ par défaut (reconnaissable) si aucun emoji fourni.
  const emoji = clampEmoji(input.emoji || (kind === "activation" ? "⚡" : ""));
  const description = clampStr(input.description != null ? input.description : input.detail || "", 4000);
  const notes = normalizeNotesInput(input.notes != null ? input.notes : "");
  const targetDate = validDateOrNull(input.targetDate != null ? input.targetDate : input.dueDate);
  const ref = nextRef(repoId, "node");
  const nextPos = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM nodes WHERE parent_id IS NULL AND repo_id = ?").get(repoId).p;
  const position = Number.isFinite(input.position) ? input.position : nextPos;
  const res = db
    .prepare(
      `INSERT INTO nodes(repo_id, ref, parent_id, root_id, depth, path, title, description, notes, status, kind, color, emoji, target_date, progress, position)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(repoId, ref, null, 0, 0, "", title, description, notes, status, kind, color, emoji, targetDate, status === "done" ? 100 : 0, position);
  const newId = Number(res.lastInsertRowid);
  db.prepare("UPDATE nodes SET root_id = ?, path = ?, done_at = ? WHERE id = ?").run(newId, "/" + newId + "/", status === "done" ? nowIso() : null, newId);
  return newId;
}

function _reparentSubtree(id, newParentId, position) {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
  if (!row) throw new Error("Nœud introuvable");
  const newParent = newParentId == null ? null : db.prepare("SELECT * FROM nodes WHERE id = ?").get(newParentId);
  if (newParentId != null && !newParent) throw new Error("Nouveau parent introuvable");
  // Un arbre ne traverse jamais 2 repos.
  if (newParent && newParent.repo_id !== row.repo_id) throw new Error("Reparentage inter-repos interdit");
  const newDepth = newParent ? newParent.depth + 1 : 0;
  const newRoot = newParent ? newParent.root_id : id;
  const newPath = (newParent ? newParent.path : "/") + id + "/";
  const oldPath = row.path;
  const subMaxDepth = db.prepare("SELECT MAX(depth) m FROM nodes WHERE path LIKE ?").get(oldPath + "%").m || row.depth;
  const depthDelta = newDepth - row.depth;
  if (subMaxDepth + depthDelta > MAX_DEPTH) throw new Error("Profondeur maximale dépassée");
  const pos =
    position != null
      ? position
      : newParentId == null
      ? db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM nodes WHERE parent_id IS NULL AND repo_id = ?").get(row.repo_id).p
      : db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM nodes WHERE parent_id = ?").get(newParentId).p;
  db.prepare("UPDATE nodes SET parent_id = ?, position = ? WHERE id = ?").run(newParentId, pos, id);
  const rows = db.prepare("SELECT id, depth, path FROM nodes WHERE path LIKE ?").all(oldPath + "%");
  // Reparenter = changement structurel : on PURGE les positions manuelles (pos_x/pos_y)
  // du nœud et de tout son sous-arbre. Sinon le sous-arbre resterait figé à ses anciennes
  // coordonnées absolues (ancien emplacement) ; remis à NULL, il reflue en auto-layout
  // sous son nouveau parent.
  const upd = db.prepare("UPDATE nodes SET depth = ?, root_id = ?, path = ?, pos_x = NULL, pos_y = NULL WHERE id = ?");
  for (const r of rows) upd.run(r.depth + depthDelta, newRoot, newPath + r.path.slice(oldPath.length), r.id);
}

function _reorderChildrenRows(parentId, orderedIds, repoId = null) {
  let where, wargs;
  if (parentId == null) {
    where = "parent_id IS NULL AND repo_id = ?";
    wargs = [repoId];
  } else {
    where = "parent_id = ?";
    wargs = [parentId];
  }
  const existing = db.prepare(`SELECT id FROM nodes WHERE ${where} ORDER BY position, id`).all(...wargs).map((r) => r.id);
  const set = new Set(existing);
  const seen = new Set();
  let pos = 0;
  const upd = db.prepare("UPDATE nodes SET position = ? WHERE id = ?");
  for (const raw of orderedIds) {
    const n = Number(raw);
    if (set.has(n) && !seen.has(n)) {
      seen.add(n);
      upd.run(pos++, n);
    }
  }
  for (const id of existing) if (!seen.has(id)) upd.run(pos++, id);
}

// ── CRUD public (chaque mutation → rollup ascendant) ─────────────────────────
export function createNode(repoId, parentRefOrId, input = {}) {
  return withRepo(repoId, () => {
    // Id numérique du dépôt courant (repoId peut être null = défaut, ou un slug).
    const rid = resolveRepoId(repoId);
    console.error(`[meowtrack] createNode: repoId=${repoId ?? "(défaut)"} → rid=${rid} parent=${parentRefOrId ?? "(racine)"}`);
    if (parentRefOrId != null) {
      // L'enfant hérite du repo de son parent (repoId ignoré si incohérent).
      const parent = findNodeRow(parentRefOrId, rid);
      if (!parent) {
        console.error(`[meowtrack] createNode: parent introuvable (${parentRefOrId}) dans repo ${rid}`);
        throw new Error(`Parent introuvable : ${parentRefOrId}`);
      }
      let id;
      db.transaction(() => {
        id = _insertChild(parent.id, input);
        recomputeAncestorProgress(id, { bumpSelf: false });
      })();
      console.error(`[meowtrack] createNode: enfant inséré id=${id} sous parent id=${parent.id}`);
      return getNode(id);
    }
    // Racine.
    const id = db.transaction(() => _insertRoot(rid, input))();
    console.error(`[meowtrack] createNode: racine insérée id=${id} dans repo ${rid}`);
    return getNode(id);
  });
}

export function updateNode(refOrId, fields = {}, expectedVersion, repoId = null) {
  return withRepo(repoId, () => {
  const row = findNodeRow(refOrId, repoId);
  if (!row) throw new Error(`Nœud introuvable : ${refOrId}`);
  const tx = db.transaction(() => {
    if (expectedVersion != null && expectedVersion !== "") {
      const cur = db.prepare("SELECT version FROM nodes WHERE id = ?").get(row.id).version;
      if (cur !== Number(expectedVersion)) {
        const err = new Error("version_conflict");
        err.code = "version_conflict";
        err.node = getNode(row.id);
        throw err;
      }
    }
    const changed = _setNodeFields(row.id, fields);
    recomputeAncestorProgress(row.id, { bumpSelf: changed > 0 });
  });
  tx();
  return getNode(row.id);
  });
}

export function deleteNode(refOrId, repoId = null) {
  return withRepo(repoId, () => {
  const row = findNodeRow(refOrId, repoId);
  if (!row) return { deleted: false };
  const parentId = row.parent_id;
  db.transaction(() => {
    db.prepare("DELETE FROM nodes WHERE id = ?").run(row.id); // cascade sous-arbre + messages
    if (parentId != null) recomputeAncestorProgress(parentId, { bumpSelf: true });
  })();
  return { deleted: true, id: row.id, parentId, rootId: row.root_id };
  });
}

export function moveNode(refOrId, newParentRefOrId, position, repoId = null) {
  return withRepo(repoId, () => {
  const row = findNodeRow(refOrId, repoId);
  if (!row) throw new Error(`Nœud introuvable : ${refOrId}`);
  const newParent = newParentRefOrId == null ? null : findNodeRow(newParentRefOrId, repoId);
  if (newParentRefOrId != null && !newParent) throw new Error("Nouveau parent introuvable");
  if (newParent) {
    if (newParent.id === row.id) throw new Error("Un nœud ne peut pas être son propre parent");
    if (newParent.repo_id !== row.repo_id) throw new Error("Déplacement inter-repos interdit");
    if (newParent.path.startsWith(row.path)) throw new Error("Cycle : le nouveau parent est dans le sous-arbre déplacé");
  }
  const oldParentId = row.parent_id;
  const newParentId = newParent ? newParent.id : null;
  db.transaction(() => {
    _reparentSubtree(row.id, newParentId, Number.isFinite(position) ? position : null);
    recomputeAncestorProgress(row.id, { bumpSelf: true });
    if (oldParentId != null && oldParentId !== newParentId) recomputeAncestorProgress(oldParentId, { bumpSelf: true });
  })();
  return getNode(row.id);
  });
}

export function reorderChildren(parentRefOrId, orderedIds = [], repoId = null) {
  return withRepo(repoId, () => {
  let pId = null;
  let rId = repoId != null ? resolveRepoId(repoId) : null;
  if (parentRefOrId != null) {
    const p = findNodeRow(parentRefOrId, repoId);
    if (!p) throw new Error(`Nœud introuvable : ${parentRefOrId}`);
    pId = p.id;
    rId = p.repo_id;
  }
  if (pId == null && rId == null) throw new Error("repoId requis pour réordonner des racines");
  db.transaction(() => {
    _reorderChildrenRows(pId, orderedIds, rId);
    if (pId != null) recomputeAncestorProgress(pId, { bumpSelf: true });
  })();
  return pId != null ? getNode(pId, { withTree: true }) : listRootNodes(rId);
  });
}

export function setNodePositions(positions = [], repoId = null) {
  return withRepo(repoId, () => {
  const upd = db.prepare("UPDATE nodes SET pos_x = ?, pos_y = ? WHERE id = ?");
  db.transaction(() => {
    for (const p of positions || []) {
      const row = findNodeRow(p && p.id, repoId);
      if (row) upd.run(p.x == null ? null : Number(p.x), p.y == null ? null : Number(p.y), row.id);
    }
  })();
  return (positions || []).length;
  });
}

// ── Liens de PRÉREQUIS (graphe additif, hors hiérarchie) ─────────────────────
// from = dépendant, to = prérequis (« from dépend de to »). N'affecte ni le path
// ni la progression : purement relationnel + signal de blocage côté UI. Les deux
// extrémités sont dans la même base tracker → un lien est intrinsèquement intra-repo.

// Résumé léger d'un nœud cible/source d'un lien (pour les listes côté UI).
function linkSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    status: row.status,
    emoji: row.emoji,
    color: row.color,
    progress: Math.max(0, Math.min(100, row.progress | 0)),
    depth: row.depth,
  };
}

// { requires: [prérequis de ce nœud], requiredBy: [nœuds qui en dépendent] }.
function nodeLinksOf(id) {
  const sel = db.prepare("SELECT * FROM nodes WHERE id = ?");
  const reqRows = db.prepare("SELECT to_id AS oid, id AS linkId FROM node_links WHERE from_id = ? AND kind = 'requires'").all(id);
  const byRows = db.prepare("SELECT from_id AS oid, id AS linkId FROM node_links WHERE to_id = ? AND kind = 'requires'").all(id);
  const map = (r) => { const s = linkSummary(sel.get(r.oid)); return s && { ...s, linkId: r.linkId }; };
  return {
    requires: reqRows.map(map).filter(Boolean),
    requiredBy: byRows.map(map).filter(Boolean),
  };
}
export function listNodeLinks(refOrId, repoId = null) {
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) return { requires: [], requiredBy: [] };
    return nodeLinksOf(row.id);
  });
}

// Entrées de suivi (issues) liées à ce jalon (table issue_nodes, même base tracker).
// Lecture directe de la table `issues` (pas d'import de db/issues.js) pour éviter de
// resserrer le cycle ESM ; on ne renvoie qu'un résumé d'affichage.
function nodeIssuesOf(id) {
  return db
    .prepare(
      `SELECT i.id, i.ref, i.title, i.type, i.status, i.priority
         FROM issue_nodes il JOIN issues i ON i.id = il.issue_id
        WHERE il.node_id = ?
        ORDER BY i.id`
    )
    .all(id);
}

// Tous les liens d'un repo, à plat — pour le graphe (mêmes ids que listForest).
export function listForestLinks(repoId) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
    const rid = resolveRepoId(repoId);
    // Jointure sur from_id pour ne garder que les liens du repo (les deux extrémités
    // partagent forcément le repo, le path n'étant pas inter-repos).
    return db
      .prepare(
        `SELECT l.id AS id, l.from_id AS fromId, l.to_id AS toId, l.kind AS kind
           FROM node_links l JOIN nodes n ON n.id = l.from_id
          WHERE n.repo_id = ? ORDER BY l.id`
      )
      .all(rid)
      .map((r) => ({ id: r.id, fromId: r.fromId, toId: r.toId, kind: r.kind }));
  });
}

// `to` est-il déjà accessible depuis `from` en suivant les arêtes 'requires' ?
// (détection de cycle avant insertion : on refuse from→to si to peut déjà atteindre from).
function requiresReaches(startId, targetId) {
  const seen = new Set();
  const stack = [startId];
  const next = db.prepare("SELECT to_id FROM node_links WHERE from_id = ? AND kind = 'requires'");
  while (stack.length) {
    const cur = stack.pop();
    if (cur === targetId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of next.all(cur)) stack.push(r.to_id);
  }
  return false;
}

// Cœur d'insertion d'un lien PAR IDS (suppose les deux ids résolus + même repo
// déjà garanti par l'appelant). Garde : anti-auto-lien, anti-cycle, cap par nœud.
// Idempotent (INSERT OR IGNORE). Utilisé par addNodeLink ET les actions IA — à
// appeler dans un contexte `withRepo` actif (ambient `db`).
function _linkInsert(fromId, toId, kind) {
  if (fromId === toId) throw new Error("Un nœud ne peut pas être son propre prérequis");
  if (kind === "requires" && requiresReaches(toId, fromId)) throw new Error("Cycle de prérequis interdit");
  const n = db.prepare("SELECT COUNT(*) c FROM node_links WHERE from_id = ? AND kind = ?").get(fromId, kind).c;
  if (n >= MAX_LINKS_PER_NODE) throw new Error("Trop de prérequis sur ce nœud");
  const res = db.prepare("INSERT OR IGNORE INTO node_links(from_id, to_id, kind) VALUES(?,?,?)").run(fromId, toId, kind);
  return { id: Number(res.lastInsertRowid) || null, created: res.changes > 0 };
}
function _linkDelete(fromId, toId, kind) {
  return db.prepare("DELETE FROM node_links WHERE from_id = ? AND to_id = ? AND kind = ?").run(fromId, toId, kind).changes > 0;
}

// Crée un lien « from dépend de to ». Fail-closed : extrémités du même repo, pas
// d'auto-lien, type connu, anti-cycle, cap par nœud. Idempotent (UNIQUE).
export function addNodeLink(fromRefOrId, toRefOrId, { kind = "requires", repoId = null } = {}) {
  return withRepo(repoId, () => {
    if (!NODE_LINK_KIND_SET.has(kind)) throw new Error(`Type de lien invalide : ${kind}`);
    const from = findNodeRow(fromRefOrId, repoId);
    const to = findNodeRow(toRefOrId, repoId);
    if (!from) throw new Error(`Nœud introuvable : ${fromRefOrId}`);
    if (!to) throw new Error(`Nœud introuvable : ${toRefOrId}`);
    if (from.repo_id !== to.repo_id) throw new Error("Lien inter-repos interdit");
    let r;
    db.transaction(() => { r = _linkInsert(from.id, to.id, kind); })();
    return { link: { id: r.id, fromId: from.id, toId: to.id, kind, created: r.created }, fromId: from.id, toId: to.id, repoId: from.repo_id };
  });
}

// Supprime un lien from→to (par défaut 'requires'). Idempotent.
export function removeNodeLink(fromRefOrId, toRefOrId, { kind = "requires", repoId = null } = {}) {
  return withRepo(repoId, () => {
    const from = findNodeRow(fromRefOrId, repoId);
    const to = findNodeRow(toRefOrId, repoId);
    if (!from || !to) return { removed: false };
    const removed = _linkDelete(from.id, to.id, kind);
    return { removed, fromId: from.id, toId: to.id, repoId: from.repo_id };
  });
}

// ── Application des actions IA (cœur sécurité — catalogue scopé subtree) ──────
export function applyNodeActions(scopeNodeId, actions = [], repoId = null) {
  return withRepo(repoId, () => {
  const scope = findNodeRow(scopeNodeId, repoId);
  if (!scope) throw new Error(`Nœud introuvable : ${scopeNodeId}`);
  const applied = [];
  const rejected = [];
  const list = Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS) : [];
  const touched = new Set();
  const affected = new Set();
  const roots = new Set();
  let linksChanged = false;

  const tx = db.transaction(() => {
    const tmpMap = new Map();
    const resolve = (x) => {
      if (x == null) return null;
      const s = String(x);
      if (tmpMap.has(s)) return tmpMap.get(s);
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };
    const inScope = (id) => id != null && isInSubtree(scope.id, id);
    for (const a of list) {
      const op = a && a.op;
      try {
        switch (op) {
          case "set_node_fields":
          case "update_node": {
            const id = op === "set_node_fields" && a.id == null ? scope.id : resolve(a.id);
            if (!inScope(id)) {
              rejected.push({ op, reason: "hors_scope" });
              break;
            }
            const n = _setNodeFields(id, a);
            if (n) {
              applied.push({ op, id });
              touched.add(id);
            } else rejected.push({ op, id, reason: "aucun_champ" });
            break;
          }
          case "add_node": {
            const pid = a.parentId == null ? scope.id : resolve(a.parentId);
            if (!inScope(pid)) {
              rejected.push({ op, reason: "parent_hors_scope" });
              break;
            }
            if (descendantCount(findNodeRow(scope.id)) >= MAX_NODES_PER_SUBTREE) {
              rejected.push({ op, reason: "quota_sous_arbre" });
              break;
            }
            const newId = _insertChild(pid, a);
            if (a.tmpKey != null) tmpMap.set(String(a.tmpKey), newId);
            applied.push({ op, id: newId, parentId: pid, title: String(a.title || "").slice(0, 200) });
            touched.add(newId);
            touched.add(pid);
            break;
          }
          case "delete_node": {
            const id = resolve(a.id);
            if (!inScope(id)) {
              rejected.push({ op, reason: "hors_scope" });
              break;
            }
            if (id === scope.id) {
              rejected.push({ op, reason: "auto_suppression_racine_interdite" });
              break;
            }
            const node = findNodeRow(id);
            const parentId = node ? node.parent_id : null;
            const ch = db.prepare("DELETE FROM nodes WHERE id = ?").run(id).changes;
            if (ch) {
              applied.push({ op, id });
              if (parentId != null) touched.add(parentId);
            } else rejected.push({ op, id, reason: "introuvable" });
            break;
          }
          case "move_node": {
            const id = resolve(a.id);
            const newParent = a.parentId == null ? scope.id : resolve(a.parentId);
            if (!inScope(id)) {
              rejected.push({ op, reason: "source_hors_scope" });
              break;
            }
            if (!inScope(newParent)) {
              rejected.push({ op, reason: "cible_hors_scope" });
              break;
            }
            if (id === newParent || isInSubtree(id, newParent)) {
              rejected.push({ op, reason: "cycle" });
              break;
            }
            const oldParent = findNodeRow(id)?.parent_id ?? null;
            _reparentSubtree(id, newParent, Number.isFinite(a.position) ? a.position : null);
            applied.push({ op, id, parentId: newParent });
            touched.add(id);
            if (oldParent != null) touched.add(oldParent);
            touched.add(newParent);
            break;
          }
          case "reorder_children": {
            const pid = a.parentId == null ? scope.id : resolve(a.parentId);
            if (!inScope(pid)) {
              rejected.push({ op, reason: "parent_hors_scope" });
              break;
            }
            const ids = (a.order || []).map(resolve).filter((x) => x != null && inScope(x));
            _reorderChildrenRows(pid, ids);
            applied.push({ op, parentId: pid });
            touched.add(pid);
            break;
          }
          case "add_link": {
            // Prérequis : `from` dépend de `to`. Les DEUX extrémités doivent être dans
            // le sous-arbre du scope (un lien hors scope passe par le chat « top level »).
            const kind = NODE_LINK_KIND_SET.has(a.kind) ? a.kind : "requires";
            const from = a.from == null ? scope.id : resolve(a.from);
            const to = resolve(a.to);
            if (!inScope(from) || !inScope(to)) {
              rejected.push({ op, reason: "hors_scope" });
              break;
            }
            const r = _linkInsert(from, to, kind); // throw → catch (cycle/cap/auto-lien)
            applied.push({ op, from, to, created: r.created });
            if (r.created) { linksChanged = true; touched.add(from); touched.add(to); }
            break;
          }
          case "remove_link": {
            const kind = NODE_LINK_KIND_SET.has(a.kind) ? a.kind : "requires";
            const from = a.from == null ? scope.id : resolve(a.from);
            const to = resolve(a.to);
            if (!inScope(from) || !inScope(to)) {
              rejected.push({ op, reason: "hors_scope" });
              break;
            }
            const removed = _linkDelete(from, to, kind);
            applied.push({ op, from, to, removed });
            if (removed) { linksChanged = true; touched.add(from); touched.add(to); }
            break;
          }
          default:
            rejected.push({ op: op || "?", reason: "op_inconnu" });
        }
      } catch (e) {
        rejected.push({ op: op || "?", reason: e.message || String(e) });
      }
    }
    for (const id of touched) {
      affected.add(id);
      for (const r of recomputeAncestorProgress(id, { bumpSelf: true })) {
        affected.add(r.id);
        roots.add(r.root_id);
      }
    }
  });
  tx();
  if (rejected.length)
    console.error(`[meowtrack] applyActions: ${applied.length} appliquée(s), ${rejected.length} rejetée(s) → ${JSON.stringify(rejected)}`);
  return { applied, rejected, affectedNodeIds: [...affected], roots: [...roots], linksChanged };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATEUR — file de travail (bail) sur l'arbre de nœuds.
//
// Le `status` (active|paused|done|abandoned) = INTENTION de planning ; le bail
// (run_state/lease_owner/lease_until) = coordination d'EXÉCUTION. Une « tâche
// exécutable » = une FEUILLE active, débloquée (tous prérequis 'done'), au bail
// libre. La réclamation est un compare-and-swap en UNE instruction (pas de TOCTOU).
// ═══════════════════════════════════════════════════════════════════════════

// Ordre d'exécution = ORDRE DU PLAN : parcours en profondeur (DFS) de l'arbre, frères
// triés par `position` (l'ordre tel que défini / réordonné dans Vibes), feuilles
// collectées dans cet ordre. C'est l'ordre dans lequel les tâches apparaissent dans
// le plan — pas « toutes les feuilles peu profondes d'abord », ni un tri par date.
// Les prérequis restent une CONTRAINTE DURE (filtrée au claim), pas un critère de tri.
function orderedLeafIds(repoId) {
  const rows = db.prepare("SELECT id, parent_id FROM nodes WHERE repo_id = ? ORDER BY position, id").all(repoId);
  const childrenOf = new Map(); // parentId (0 = racines) → [ids] dans l'ordre position,id
  const hasChildren = new Set();
  for (const r of rows) {
    const key = r.parent_id == null ? 0 : r.parent_id;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(r.id);
    if (r.parent_id != null) hasChildren.add(r.parent_id);
  }
  const leaves = [];
  const walk = (key) => {
    for (const id of childrenOf.get(key) || []) {
      if (hasChildren.has(id)) walk(id); // descend dans les sous-jalons (DFS)
      else leaves.push(id);              // feuille = tâche exécutable
    }
  };
  walk(0);
  return leaves;
}

// Réclame la prochaine tâche PRÊTE pour `owner`, dans l'ORDRE DU PLAN. null si rien
// n'est prêt. Démarre un run (node_runs) lié au bail. L'exclusivité tient : chaque
// candidat est réclamé par un compare-and-swap (UPDATE … WHERE <encore réclamable>
// RETURNING) ; si deux workers visent la même feuille, un seul UPDATE matche, l'autre
// passe à la suivante. Le tri (DFS par position) est calculé en amont, la garde de
// réclamabilité (feuille active, débloquée, bail libre/expiré) reste dans le CAS.
export function claimNextNode(repoId, owner, { leaseMs = 600000, maxAttempts = 3, branch = null } = {}) {
  if (!owner) throw new Error("owner requis pour réclamer une tâche");
  return withRepo(repoId, () => {
    const rid = resolveRepoId(repoId);
    const now = nowIso();
    const leaseUntil = new Date(Date.parse(now) + Math.max(1000, leaseMs)).toISOString();
    const cas = db.prepare(
      `UPDATE nodes
          SET run_state='running', lease_owner=@owner, lease_until=@leaseUntil,
              run_attempts = run_attempts + 1, version = version + 1, updated_at=@ts
        WHERE id = @id
          AND repo_id = @repo
          AND status  = 'active'
          AND kind IS NOT 'activation'                                                     -- node d'activation = porte manuelle, jamais exécutée
          AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = nodes.id)              -- feuille
          AND run_state IS NOT 'done'                                                      -- pas terminée
          AND run_state IS NOT 'review'                                                    -- pas en attente de revue
          AND run_attempts < @maxAttempts
          AND (                                                                            -- libre, en échec, ou bail expiré (worker mort)
                run_state IS NULL
             OR run_state = 'failed'
             OR lease_owner IS NULL
             OR lease_until IS NULL
             OR lease_until < @now
          )
          AND NOT EXISTS (                                                                 -- tous prérequis 'done'
            SELECT 1 FROM node_links l JOIN nodes p ON p.id = l.to_id
             WHERE l.from_id = nodes.id AND l.kind = 'requires' AND p.status <> 'done'
          )
        RETURNING *`
    );
    let claimed = null;
    db.transaction(() => {
      for (const id of orderedLeafIds(rid)) {
        const row = cas.get({ id, repo: rid, owner, leaseUntil, now, ts: now, maxAttempts: Math.max(1, maxAttempts) });
        if (row) {
          startRun(row.id, owner, branch);
          claimed = row;
          break; // 1re feuille réclamable dans l'ordre du plan
        }
      }
    })();
    return claimed ? rowToNode(claimed) : null;
  });
}

// Démarre MANUELLEMENT un nœud (depuis Claude Code / MCP) : pose run_state='running'
// + un bail pour `owner`, et ouvre un run (node_runs) pour que le cycle
// complete/fail fonctionne. Contrairement à claimNextNode (orchestrateur), n'exige
// PAS une feuille ni des prérequis satisfaits — c'est un démarrage explicite à la
// main. Refuse un node d'activation (porte) et un nœud non 'active', terminé, en
// revue, ou dont le bail appartient à un AUTRE worker encore valide. Renvoie le nœud
// (run_state='running') ou lève { code:'not_startable' }.
export function startNode(refOrId, owner, { leaseMs = 600000, branch = null } = {}, repoId = null) {
  if (!owner) throw new Error("owner requis pour démarrer une tâche");
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) throw new Error(`Nœud introuvable : ${refOrId}`);
    const now = nowIso();
    const leaseUntil = new Date(Date.parse(now) + Math.max(1000, leaseMs)).toISOString();
    let started = null;
    db.transaction(() => {
      const r = db
        .prepare(
          `UPDATE nodes
              SET run_state='running', lease_owner=@owner, lease_until=@leaseUntil,
                  run_attempts = run_attempts + 1, version = version + 1, updated_at=@ts
            WHERE id = @id
              AND status = 'active'
              AND kind IS NOT 'activation'
              AND run_state IS NOT 'done'
              AND run_state IS NOT 'review'
              AND (run_state IS NOT 'running' OR lease_owner = @owner OR lease_until IS NULL OR lease_until < @now)
            RETURNING *`
        )
        .get({ id: row.id, owner, leaseUntil, now, ts: now });
      if (!r) {
        const e = new Error("non_demarrable");
        e.code = "not_startable";
        throw e;
      }
      startRun(r.id, owner, branch);
      started = r;
    })();
    return rowToNode(started);
  });
}

// Prolonge le bail (heartbeat des tâches longues). false → bail perdu (préempté).
export function renewLease(refOrId, owner, leaseMs = 600000, repoId = null) {
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) return false;
    const until = new Date(Date.parse(nowIso()) + Math.max(1000, leaseMs)).toISOString();
    return (
      db
        .prepare("UPDATE nodes SET lease_until=? WHERE id=? AND lease_owner=? AND run_state='running'")
        .run(until, row.id, owner).changes === 1
    );
  });
}

// Clôt une tâche : seul le détenteur du bail peut clore. hasBlockingReview → la tâche
// passe 'review' (ne débloque PAS les dépendants) au lieu de 'done'. Lève lease_lost
// si le bail a changé de main (préemption).
// Verse un récap d'implémentation dans une NOTE persistante du nœud (visible/durable
// dans le panneau détail, contrairement au summary qui ne vit que dans node_runs).
// Sémantique APPEND : une note par run (titre numéroté + daté) → conserve l'historique
// multi-tentatives. Best-effort : sans summary, rien n'est ajouté. À appeler DANS la
// transaction de completeNode, AVANT finishRun (le run courant 'running' existe encore).
function appendRecapNote(nodeId, { summary, branch, testResult, state } = {}) {
  const text = String(summary || "").trim();
  if (!text) return; // rien à consigner
  const row = db.prepare("SELECT notes FROM nodes WHERE id = ?").get(nodeId);
  const notes = parseNotes(row && row.notes);
  const runCount = (db.prepare("SELECT COUNT(*) c FROM node_runs WHERE node_id = ?").get(nodeId) || {}).c || 0;
  const meta = [];
  if (branch) meta.push(`Branche : \`${branch}\``);
  if (testResult) meta.push(`Tests : ${testResult}`);
  if (state) meta.push(`État : ${state}`);
  const body = (meta.length ? meta.join(" · ") + "\n\n" : "") + text;
  notes.push({ title: `📝 Compte-rendu — run #${runCount} (${nowIso().slice(0, 10)})`, body });
  _setNodeFields(nodeId, { notes });
}

export function completeNode(refOrId, owner, { summary, branch, testResult, report, hasBlockingReview } = {}, repoId = null) {
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) throw new Error(`Nœud introuvable : ${refOrId}`);
    let affected = [];
    db.transaction(() => {
      const next = hasBlockingReview ? "review" : "done";
      const ok =
        db
          .prepare("UPDATE nodes SET run_state=?, lease_owner=NULL, lease_until=NULL WHERE id=? AND lease_owner=?")
          .run(next, row.id, owner).changes === 1;
      if (!ok) {
        const e = new Error("bail_perdu");
        e.code = "lease_lost";
        throw e;
      }
      if (!hasBlockingReview) {
        _setNodeFields(row.id, { status: "done" }); // → done_at + statut
        affected = recomputeAncestorProgress(row.id, { bumpSelf: true }).map((r) => r.id); // progression remonte
      } else {
        affected = [row.id];
      }
      // Récap d'implémentation versé en note persistante du nœud (avant finishRun :
      // le run 'running' courant est encore ouvert → numérotation cohérente).
      appendRecapNote(row.id, { summary, branch, testResult, state: next });
      finishRun(row.id, owner, next, { summary, branch, testResult, report });
    })();
    return { ok: true, state: hasBlockingReview ? "review" : "done", affectedNodeIds: affected, nodeId: row.id };
  });
}

// Échec : libère le bail, laisse run_state='failed' (rejouable tant que attempts < max).
export function failNode(refOrId, owner, { error, branch } = {}, repoId = null) {
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) throw new Error(`Nœud introuvable : ${refOrId}`);
    db.transaction(() => {
      db.prepare("UPDATE nodes SET run_state='failed', lease_owner=NULL, lease_until=NULL WHERE id=? AND lease_owner=?").run(row.id, owner);
      finishRun(row.id, owner, "failed", { error, branch });
    })();
    return { ok: true, state: "failed", nodeId: row.id };
  });
}

// Promeut une tâche en 'done' (chemin de résolution de revue : review→done). Met le
// statut, le run_state, vide le bail, fait remonter la progression. Renvoie les ids
// affectés.
export function markNodeDone(refOrId, repoId = null) {
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) return [];
    let affected = [];
    db.transaction(() => {
      db.prepare("UPDATE nodes SET run_state='done', lease_owner=NULL, lease_until=NULL WHERE id=?").run(row.id);
      _setNodeFields(row.id, { status: "done" });
      affected = recomputeAncestorProgress(row.id, { bumpSelf: true }).map((r) => r.id);
    })();
    return affected;
  });
}

// Remet une tâche dans la file (rework) : statut 'active', bail/run_state vidés →
// reréclamable. N'incrémente pas run_attempts (la réclamation le fera).
export function requeueNode(refOrId, repoId = null) {
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) return false;
    db.prepare("UPDATE nodes SET run_state=NULL, lease_owner=NULL, lease_until=NULL, status='active' WHERE id=?").run(row.id);
    return true;
  });
}

// Incrémente le compteur d'auto-revues d'un nœud, renvoie la nouvelle valeur
// (anti-boucle d'auto-revue — cf. autoReviewForest).
export function bumpAutoReviews(refOrId, repoId = null) {
  return withRepo(repoId, () => {
    const row = findNodeRow(refOrId, repoId);
    if (!row) return 0;
    db.prepare("UPDATE nodes SET auto_reviews = auto_reviews + 1 WHERE id=?").run(row.id);
    return (row.auto_reviews | 0) + 1;
  });
}

// ── Application des actions IA « top level » (scope = repo entier) ─────────────
// Pendant de applyNodeActions, mais la garde est l'appartenance au repo (et non un
// sous-arbre) : add_node sans parentId crée un OBJECTIF RACINE. Tout id cible doit
// appartenir au repo ; cap global par repo. Reste fail-closed et transactionnel.
export function applyForestActions(repoIdParam, actions = []) {
  if (repoIdParam == null) throw new Error("repoId requis");
  return withRepo(repoIdParam, () => {
  const repoId = resolveRepoId(repoIdParam);
  const applied = [];
  const rejected = [];
  const list = Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS) : [];
  const touched = new Set();
  const affected = new Set();
  const roots = new Set();
  let linksChanged = false;

  const inRepo = (id) => {
    if (id == null) return false;
    const n = findNodeRow(id);
    return !!n && n.repo_id === repoId;
  };

  const tx = db.transaction(() => {
    const tmpMap = new Map();
    const resolve = (x) => {
      if (x == null) return null;
      const s = String(x);
      if (tmpMap.has(s)) return tmpMap.get(s);
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };
    const repoCount = () => db.prepare("SELECT COUNT(*) c FROM nodes WHERE repo_id = ?").get(repoId).c;
    for (const a of list) {
      const op = a && a.op;
      try {
        switch (op) {
          case "set_node_fields":
          case "update_node": {
            const id = resolve(a.id);
            if (!inRepo(id)) {
              rejected.push({ op, reason: "hors_repo" });
              break;
            }
            const n = _setNodeFields(id, a);
            if (n) {
              applied.push({ op, id });
              touched.add(id);
            } else rejected.push({ op, id, reason: "aucun_champ" });
            break;
          }
          case "add_node": {
            if (repoCount() >= MAX_NODES_PER_REPO) {
              rejected.push({ op, reason: "quota_repo" });
              break;
            }
            let newId;
            let parentId = null;
            if (a.parentId == null) {
              newId = _insertRoot(repoId, a); // objectif racine
            } else {
              parentId = resolve(a.parentId);
              if (!inRepo(parentId)) {
                rejected.push({ op, reason: "parent_hors_repo" });
                break;
              }
              newId = _insertChild(parentId, a);
              touched.add(parentId);
            }
            if (a.tmpKey != null) tmpMap.set(String(a.tmpKey), newId);
            applied.push({ op, id: newId, parentId, title: String(a.title || "").slice(0, 200) });
            touched.add(newId);
            break;
          }
          case "delete_node": {
            const id = resolve(a.id);
            if (!inRepo(id)) {
              rejected.push({ op, reason: "hors_repo" });
              break;
            }
            const node = findNodeRow(id);
            const parentId = node ? node.parent_id : null;
            const ch = db.prepare("DELETE FROM nodes WHERE id = ?").run(id).changes;
            if (ch) {
              applied.push({ op, id });
              if (parentId != null) touched.add(parentId);
            } else rejected.push({ op, id, reason: "introuvable" });
            break;
          }
          case "move_node": {
            const id = resolve(a.id);
            const newParent = a.parentId == null ? null : resolve(a.parentId); // null = devient racine
            if (!inRepo(id)) {
              rejected.push({ op, reason: "source_hors_repo" });
              break;
            }
            if (newParent != null && !inRepo(newParent)) {
              rejected.push({ op, reason: "cible_hors_repo" });
              break;
            }
            if (newParent != null && (id === newParent || isInSubtree(id, newParent))) {
              rejected.push({ op, reason: "cycle" });
              break;
            }
            const oldParent = findNodeRow(id)?.parent_id ?? null;
            _reparentSubtree(id, newParent, Number.isFinite(a.position) ? a.position : null);
            applied.push({ op, id, parentId: newParent });
            touched.add(id);
            if (oldParent != null) touched.add(oldParent);
            if (newParent != null) touched.add(newParent);
            break;
          }
          case "reorder_children": {
            const pid = a.parentId == null ? null : resolve(a.parentId); // null = racines du repo
            if (pid != null && !inRepo(pid)) {
              rejected.push({ op, reason: "parent_hors_repo" });
              break;
            }
            const ids = (a.order || []).map(resolve).filter((x) => x != null && inRepo(x));
            _reorderChildrenRows(pid, ids, repoId);
            applied.push({ op, parentId: pid });
            if (pid != null) touched.add(pid);
            break;
          }
          case "add_link": {
            // Prérequis « from dépend de to ». Au niveau forêt, les deux extrémités
            // doivent juste appartenir au repo (pas de scope sous-arbre). `from` requis.
            const kind = NODE_LINK_KIND_SET.has(a.kind) ? a.kind : "requires";
            const from = resolve(a.from);
            const to = resolve(a.to);
            if (!inRepo(from) || !inRepo(to)) {
              rejected.push({ op, reason: "hors_repo" });
              break;
            }
            const r = _linkInsert(from, to, kind); // throw → catch (cycle/cap/auto-lien)
            applied.push({ op, from, to, created: r.created });
            if (r.created) { linksChanged = true; touched.add(from); touched.add(to); }
            break;
          }
          case "remove_link": {
            const kind = NODE_LINK_KIND_SET.has(a.kind) ? a.kind : "requires";
            const from = resolve(a.from);
            const to = resolve(a.to);
            if (!inRepo(from) || !inRepo(to)) {
              rejected.push({ op, reason: "hors_repo" });
              break;
            }
            const removed = _linkDelete(from, to, kind);
            applied.push({ op, from, to, removed });
            if (removed) { linksChanged = true; touched.add(from); touched.add(to); }
            break;
          }
          default:
            rejected.push({ op: op || "?", reason: "op_inconnu" });
        }
      } catch (e) {
        rejected.push({ op: op || "?", reason: e.message || String(e) });
      }
    }
    for (const id of touched) {
      affected.add(id);
      for (const r of recomputeAncestorProgress(id, { bumpSelf: true })) {
        affected.add(r.id);
        roots.add(r.root_id);
      }
    }
  });
  tx();
  if (rejected.length)
    console.error(`[meowtrack] applyActions: ${applied.length} appliquée(s), ${rejected.length} rejetée(s) → ${JSON.stringify(rejected)}`);
  return { applied, rejected, affectedNodeIds: [...affected], roots: [...roots], linksChanged };
  });
}
