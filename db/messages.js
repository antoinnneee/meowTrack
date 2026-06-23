// db/messages.js — persistance des messages de chat IA : par NŒUD (node_messages,
// scope = sous-arbre) et « top level » par REPO (forest_messages, scope = forêt).
//
// Même surface des deux côtés ; seul le rattachement diffère (node_id vs repo_id).
// L'APPLICATION des actions IA vit dans ./nodes.js (applyNodeActions /
// applyForestActions) — ici on ne gère que les lignes de conversation.
//
// Cycle ESM SÛR avec ./nodes.js (findNodeRow) : usage en corps de fonction.

import { db, withRepo } from "./connection.js";
import { resolveRepoId } from "./registry.js";
import { MSG_STATE_SET } from "./constants.js";
import { clampStr } from "./helpers.js";
import { findNodeRow } from "./nodes.js";

// ── Chat (par nœud) ──────────────────────────────────────────────────────────
function rowToNodeMessage(r) {
  if (!r) return null;
  let actions = [];
  try {
    actions = JSON.parse(r.actions || "[]");
  } catch {
    actions = [];
  }
  return {
    id: r.id,
    nodeId: r.node_id,
    sessionId: r.session_id || 0, // 0 = conversation par défaut (session_id NULL)
    role: r.role,
    author: r.author,
    model: r.model,
    body: r.body,
    reasoning: r.reasoning,
    state: r.state,
    actions,
    clientNonce: r.client_nonce,
    createdAt: r.created_at,
  };
}
// Normalise un identifiant de session venant de l'extérieur : 0 / null / undefined /
// vide → NULL (conversation par défaut) ; sinon un entier positif.
function normSession(sessionId) {
  const n = Number(sessionId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function clearNodeMessages(nodeRefOrId, repoId = null, sessionId = 0) {
  return withRepo(repoId, () => {
    const node = findNodeRow(nodeRefOrId, repoId);
    if (!node) throw new Error(`Nœud introuvable : ${nodeRefOrId}`);
    const sid = normSession(sessionId);
    return sid == null
      ? db.prepare("DELETE FROM node_messages WHERE node_id = ? AND session_id IS NULL").run(node.id).changes
      : db.prepare("DELETE FROM node_messages WHERE node_id = ? AND session_id = ?").run(node.id, sid).changes;
  });
}

export function deleteNodeMessage(messageId, nodeRefOrId, repoId = null) {
  return withRepo(repoId, () => {
    const node = findNodeRow(nodeRefOrId, repoId);
    if (!node) throw new Error(`Nœud introuvable : ${nodeRefOrId}`);
    return db.prepare("DELETE FROM node_messages WHERE id = ? AND node_id = ?").run(messageId, node.id).changes;
  });
}

export function listNodeMessages(nodeId, { afterId = 0, limit = 500, repoId = null, sessionId = 0 } = {}) {
  return withRepo(repoId, () => {
    const sid = normSession(sessionId);
    const lim = Math.max(1, Math.min(1000, limit));
    const sql = sid == null
      ? "SELECT * FROM node_messages WHERE node_id = ? AND id > ? AND session_id IS NULL ORDER BY id LIMIT ?"
      : "SELECT * FROM node_messages WHERE node_id = ? AND id > ? AND session_id = ? ORDER BY id LIMIT ?";
    const args = sid == null ? [nodeId, afterId, lim] : [nodeId, afterId, sid, lim];
    return db.prepare(sql).all(...args).map(rowToNodeMessage);
  });
}

export function getNodeMessage(messageId, repoId = null) {
  return withRepo(repoId, () => rowToNodeMessage(db.prepare("SELECT * FROM node_messages WHERE id = ?").get(messageId)));
}

export function addNodeMessage(nodeRefOrId, { role, author, model, body, reasoning, state, actions, clientNonce, sessionId } = {}, repoId = null) {
  return withRepo(repoId, () => {
  const node = findNodeRow(nodeRefOrId, repoId);
  if (!node) throw new Error(`Nœud introuvable : ${nodeRefOrId}`);
  const r = role === "assistant" ? "assistant" : "user";
  const st = MSG_STATE_SET.has(state) ? state : "complete";
  const nonce = clientNonce ? String(clientNonce).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || null : null;
  const res = db
    .prepare(
      "INSERT INTO node_messages(node_id, session_id, role, author, model, body, reasoning, state, actions, client_nonce) VALUES(?,?,?,?,?,?,?,?,?,?)"
    )
    .run(
      node.id,
      normSession(sessionId),
      r,
      String(author || "anon").slice(0, 60) || "anon",
      model || null,
      clampStr(body || "", 16384),
      clampStr(reasoning || "", 65536),
      st,
      JSON.stringify(actions || []),
      nonce
    );
  return getNodeMessage(Number(res.lastInsertRowid));
  });
}

export function updateNodeMessage(messageId, { body, reasoning, state, actions } = {}, repoId = null) {
  return withRepo(repoId, () => {
  const sets = [];
  const vals = [];
  if (body != null) {
    sets.push("body = ?");
    vals.push(clampStr(body, 16384));
  }
  if (reasoning != null) {
    sets.push("reasoning = ?");
    vals.push(clampStr(reasoning, 65536));
  }
  if (state != null) {
    if (!MSG_STATE_SET.has(state)) throw new Error(`État de message invalide : ${state}`);
    sets.push("state = ?");
    vals.push(state);
  }
  if (actions != null) {
    sets.push("actions = ?");
    vals.push(JSON.stringify(actions));
  }
  if (sets.length) db.prepare(`UPDATE node_messages SET ${sets.join(", ")} WHERE id = ?`).run(...vals, messageId);
  return getNodeMessage(messageId);
  });
}

// ── File persistée des tours IA (Option B, NODE-329) ─────────────────────────
// Un message ASSISTANT à l'état `queued` représente UN tour en file : son texte
// déclencheur est le message UTILISATEUR qui le précède immédiatement (même nœud,
// même session). On le réhydrate en cherchant le user le plus récent d'id inférieur.
// L'ordre par id garantit le FIFO d'arrivée multi-clients ; la persistance fait
// survivre la file à un reload.

// Plus ancien tour en file d'un nœud (toutes sessions) : { assistant, user } ou null.
export function nextQueuedNodeTurn(nodeId, repoId = null) {
  return withRepo(repoId, () => {
    const a = db
      .prepare("SELECT * FROM node_messages WHERE node_id = ? AND role = 'assistant' AND state = 'queued' ORDER BY id LIMIT 1")
      .get(nodeId);
    if (!a) return null;
    const u = a.session_id == null
      ? db.prepare("SELECT * FROM node_messages WHERE node_id = ? AND role = 'user' AND session_id IS NULL AND id < ? ORDER BY id DESC LIMIT 1").get(nodeId, a.id)
      : db.prepare("SELECT * FROM node_messages WHERE node_id = ? AND role = 'user' AND session_id = ? AND id < ? ORDER BY id DESC LIMIT 1").get(nodeId, a.session_id, a.id);
    return { assistant: rowToNodeMessage(a), user: rowToNodeMessage(u) };
  });
}

// Ids des nœuds (du repo courant) ayant au moins un tour en file — reprise au boot.
export function listQueuedNodeIds(repoId = null) {
  return withRepo(repoId, () =>
    db
      .prepare("SELECT DISTINCT node_id FROM node_messages WHERE role = 'assistant' AND state = 'queued' ORDER BY node_id")
      .all()
      .map((r) => r.node_id)
  );
}

// Repasse en `error` les placeholders assistant orphelins (pending/streaming) d'un
// tour tué par un redémarrage — sinon une bulle resterait « en cours » indéfiniment.
export function failDanglingNodeTurns(repoId = null) {
  return withRepo(repoId, () =>
    db
      .prepare(
        "UPDATE node_messages SET state = 'error', body = CASE WHEN body = '' THEN '⚠️ Tour interrompu par un redémarrage du serveur.' ELSE body END WHERE role = 'assistant' AND state IN ('pending','streaming')"
      )
      .run().changes
  );
}

// ── Chat « top level » (par repo / forêt) ────────────────────────────────────
function rowToForestMessage(r) {
  if (!r) return null;
  let actions = [];
  try {
    actions = JSON.parse(r.actions || "[]");
  } catch {
    actions = [];
  }
  return {
    id: r.id,
    repoId: r.repo_id,
    sessionId: r.session_id || 0, // 0 = conversation par défaut (session_id NULL)
    role: r.role,
    author: r.author,
    model: r.model,
    body: r.body,
    reasoning: r.reasoning,
    state: r.state,
    actions,
    clientNonce: r.client_nonce,
    createdAt: r.created_at,
  };
}

export function clearForestMessages(repoId, sessionId = 0) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
    const rid = resolveRepoId(repoId);
    const sid = normSession(sessionId);
    return sid == null
      ? db.prepare("DELETE FROM forest_messages WHERE repo_id = ? AND session_id IS NULL").run(rid).changes
      : db.prepare("DELETE FROM forest_messages WHERE repo_id = ? AND session_id = ?").run(rid, sid).changes;
  });
}

export function deleteForestMessage(messageId, repoId) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () =>
    db.prepare("DELETE FROM forest_messages WHERE id = ? AND repo_id = ?").run(messageId, resolveRepoId(repoId)).changes);
}

export function listForestMessages(repoId, { afterId = 0, limit = 500, sessionId = 0 } = {}) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
    const rid = resolveRepoId(repoId);
    const sid = normSession(sessionId);
    const lim = Math.max(1, Math.min(1000, limit));
    const sql = sid == null
      ? "SELECT * FROM forest_messages WHERE repo_id = ? AND id > ? AND session_id IS NULL ORDER BY id LIMIT ?"
      : "SELECT * FROM forest_messages WHERE repo_id = ? AND id > ? AND session_id = ? ORDER BY id LIMIT ?";
    const args = sid == null ? [rid, afterId, lim] : [rid, afterId, sid, lim];
    return db.prepare(sql).all(...args).map(rowToForestMessage);
  });
}

export function getForestMessage(messageId, repoId = null) {
  return withRepo(repoId, () => rowToForestMessage(db.prepare("SELECT * FROM forest_messages WHERE id = ?").get(messageId)));
}

export function addForestMessage(repoId, { role, author, model, body, reasoning, state, actions, clientNonce, sessionId } = {}) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
  const rid = resolveRepoId(repoId);
  const r = role === "assistant" ? "assistant" : "user";
  const st = MSG_STATE_SET.has(state) ? state : "complete";
  const nonce = clientNonce ? String(clientNonce).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || null : null;
  const res = db
    .prepare(
      "INSERT INTO forest_messages(repo_id, session_id, role, author, model, body, reasoning, state, actions, client_nonce) VALUES(?,?,?,?,?,?,?,?,?,?)"
    )
    .run(
      rid,
      normSession(sessionId),
      r,
      String(author || "anon").slice(0, 60) || "anon",
      model || null,
      clampStr(body || "", 16384),
      clampStr(reasoning || "", 65536),
      st,
      JSON.stringify(actions || []),
      nonce
    );
  return getForestMessage(Number(res.lastInsertRowid));
  });
}

export function updateForestMessage(messageId, { body, reasoning, state, actions } = {}, repoId = null) {
  return withRepo(repoId, () => {
  const sets = [];
  const vals = [];
  if (body != null) {
    sets.push("body = ?");
    vals.push(clampStr(body, 16384));
  }
  if (reasoning != null) {
    sets.push("reasoning = ?");
    vals.push(clampStr(reasoning, 65536));
  }
  if (state != null) {
    if (!MSG_STATE_SET.has(state)) throw new Error(`État de message invalide : ${state}`);
    sets.push("state = ?");
    vals.push(state);
  }
  if (actions != null) {
    sets.push("actions = ?");
    vals.push(JSON.stringify(actions));
  }
  if (sets.length) db.prepare(`UPDATE forest_messages SET ${sets.join(", ")} WHERE id = ?`).run(...vals, messageId);
  return getForestMessage(messageId);
  });
}

// ── File persistée des tours IA — versant forêt (Option B, NODE-329) ─────────
// Plus ancien tour en file d'une forêt (toutes sessions) : { assistant, user } ou null.
export function nextQueuedForestTurn(repoId) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
    const rid = resolveRepoId(repoId);
    const a = db
      .prepare("SELECT * FROM forest_messages WHERE repo_id = ? AND role = 'assistant' AND state = 'queued' ORDER BY id LIMIT 1")
      .get(rid);
    if (!a) return null;
    const u = a.session_id == null
      ? db.prepare("SELECT * FROM forest_messages WHERE repo_id = ? AND role = 'user' AND session_id IS NULL AND id < ? ORDER BY id DESC LIMIT 1").get(rid, a.id)
      : db.prepare("SELECT * FROM forest_messages WHERE repo_id = ? AND role = 'user' AND session_id = ? AND id < ? ORDER BY id DESC LIMIT 1").get(rid, a.session_id, a.id);
    return { assistant: rowToForestMessage(a), user: rowToForestMessage(u) };
  });
}

// Vrai si la forêt a au moins un tour en file — reprise au boot.
export function hasQueuedForestTurn(repoId) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
    const rid = resolveRepoId(repoId);
    return !!db.prepare("SELECT 1 FROM forest_messages WHERE repo_id = ? AND role = 'assistant' AND state = 'queued' LIMIT 1").get(rid);
  });
}

// Repasse en `error` les placeholders forêt orphelins (pending/streaming) après crash.
export function failDanglingForestTurns(repoId) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
    const rid = resolveRepoId(repoId);
    return db
      .prepare(
        "UPDATE forest_messages SET state = 'error', body = CASE WHEN body = '' THEN '⚠️ Tour interrompu par un redémarrage du serveur.' ELSE body END WHERE repo_id = ? AND role = 'assistant' AND state IN ('pending','streaming')"
      )
      .run(rid).changes;
  });
}

// ── Sessions de conversation (plusieurs historiques par nœud / par forêt) ─────
// scope='node' → ownerId = node_id ; scope='forest' → ownerId = repo_id résolu.
// La session par défaut (id 0, « Conversation ») est IMPLICITE : ce sont les
// messages à session_id NULL ; elle n'a pas de ligne dans chat_sessions.
function rowToSession(r) {
  return r ? { id: r.id, scope: r.scope, ownerId: r.owner_id, name: r.name, createdAt: r.created_at } : null;
}

// Liste les sessions explicites d'un propriétaire (la session par défaut est ajoutée
// côté appelant/route pour rester rétro-compatible avec les bases sans cette table).
export function listChatSessions(scope, ownerId, repoId = null) {
  return withRepo(repoId, () =>
    db.prepare("SELECT * FROM chat_sessions WHERE scope = ? AND owner_id = ? ORDER BY id").all(scope, ownerId).map(rowToSession)
  );
}

export function getChatSession(id, repoId = null) {
  return withRepo(repoId, () => rowToSession(db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(Number(id))));
}

export function createChatSession(scope, ownerId, name, repoId = null) {
  return withRepo(repoId, () => {
    const nm = clampStr(String(name || "").trim() || "Sans titre", 80);
    const res = db.prepare("INSERT INTO chat_sessions(scope, owner_id, name) VALUES(?,?,?)").run(scope, ownerId, nm);
    return rowToSession(db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(Number(res.lastInsertRowid)));
  });
}

export function renameChatSession(id, name, repoId = null) {
  return withRepo(repoId, () => {
    const nm = clampStr(String(name || "").trim() || "Sans titre", 80);
    db.prepare("UPDATE chat_sessions SET name = ? WHERE id = ?").run(nm, Number(id));
    return rowToSession(db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(Number(id)));
  });
}

// Supprime une session ET ses messages. Le scope+ownerId bornent la suppression des
// messages (table polymorphe sans FK), évitant tout effacement hors périmètre.
export function deleteChatSession(id, scope, ownerId, repoId = null) {
  return withRepo(repoId, () => {
    const sid = Number(id);
    if (!Number.isInteger(sid) || sid <= 0) return 0;
    const tx = db.transaction(() => {
      if (scope === "node") db.prepare("DELETE FROM node_messages WHERE node_id = ? AND session_id = ?").run(ownerId, sid);
      else db.prepare("DELETE FROM forest_messages WHERE repo_id = ? AND session_id = ?").run(ownerId, sid);
      return db.prepare("DELETE FROM chat_sessions WHERE id = ? AND scope = ? AND owner_id = ?").run(sid, scope, ownerId).changes;
    });
    return tx();
  });
}
