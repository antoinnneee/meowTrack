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

export function clearNodeMessages(nodeRefOrId, repoId = null) {
  return withRepo(repoId, () => {
    const node = findNodeRow(nodeRefOrId, repoId);
    if (!node) throw new Error(`Nœud introuvable : ${nodeRefOrId}`);
    return db.prepare("DELETE FROM node_messages WHERE node_id = ?").run(node.id).changes;
  });
}

export function listNodeMessages(nodeId, { afterId = 0, limit = 500, repoId = null } = {}) {
  return withRepo(repoId, () =>
    db
      .prepare("SELECT * FROM node_messages WHERE node_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(nodeId, afterId, Math.max(1, Math.min(1000, limit)))
      .map(rowToNodeMessage)
  );
}

export function getNodeMessage(messageId, repoId = null) {
  return withRepo(repoId, () => rowToNodeMessage(db.prepare("SELECT * FROM node_messages WHERE id = ?").get(messageId)));
}

export function addNodeMessage(nodeRefOrId, { role, author, model, body, reasoning, state, actions, clientNonce } = {}, repoId = null) {
  return withRepo(repoId, () => {
  const node = findNodeRow(nodeRefOrId, repoId);
  if (!node) throw new Error(`Nœud introuvable : ${nodeRefOrId}`);
  const r = role === "assistant" ? "assistant" : "user";
  const st = MSG_STATE_SET.has(state) ? state : "complete";
  const nonce = clientNonce ? String(clientNonce).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || null : null;
  const res = db
    .prepare(
      "INSERT INTO node_messages(node_id, role, author, model, body, reasoning, state, actions, client_nonce) VALUES(?,?,?,?,?,?,?,?,?)"
    )
    .run(
      node.id,
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

export function clearForestMessages(repoId) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => db.prepare("DELETE FROM forest_messages WHERE repo_id = ?").run(resolveRepoId(repoId)).changes);
}

export function listForestMessages(repoId, { afterId = 0, limit = 500 } = {}) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () =>
    db
      .prepare("SELECT * FROM forest_messages WHERE repo_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(resolveRepoId(repoId), afterId, Math.max(1, Math.min(1000, limit)))
      .map(rowToForestMessage)
  );
}

export function getForestMessage(messageId, repoId = null) {
  return withRepo(repoId, () => rowToForestMessage(db.prepare("SELECT * FROM forest_messages WHERE id = ?").get(messageId)));
}

export function addForestMessage(repoId, { role, author, model, body, reasoning, state, actions, clientNonce } = {}) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
  const rid = resolveRepoId(repoId);
  const r = role === "assistant" ? "assistant" : "user";
  const st = MSG_STATE_SET.has(state) ? state : "complete";
  const nonce = clientNonce ? String(clientNonce).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || null : null;
  const res = db
    .prepare(
      "INSERT INTO forest_messages(repo_id, role, author, model, body, reasoning, state, actions, client_nonce) VALUES(?,?,?,?,?,?,?,?,?)"
    )
    .run(
      rid,
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
