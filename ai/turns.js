// ai/turns.js — orchestration des tours de chat IA STREAMING (scope nœud + scope
// forêt) et handlers HTTP associés. Détient le sémaphore de concurrence IA.
//
// Pipeline : persiste le message humain + un placeholder `pending`, répond 202, puis
// streame le tour en tâche de fond (deltas → SSE, fantômes, libellé d'actions),
// parse fail-closed, applique les actions (scope validé en base), broadcast l'état
// committé. Action destructive → proposition + confirmation humaine (jamais d'auto-apply).

import { CLAUDE_BIN } from "../config.js";
import { rootForRepo } from "../repos.js";
import {
  getNode,
  getSubtree,
  getRepo,
  listForest,
  listForestLinks,
  addNodeMessage,
  updateNodeMessage,
  getNodeMessage,
  listNodeMessages,
  applyNodeActions,
  addForestMessage,
  updateForestMessage,
  getForestMessage,
  listForestMessages,
  applyForestActions,
  listIssues,
  applyIssueActions,
} from "../db.js";
import { send, readBody } from "../http-util.js";
import {
  forestKey,
  nodeKey,
  broadcast,
  broadcastMessage,
  broadcastForestMessage,
  broadcastAffected,
} from "../sse.js";
import { buildNodePrompt, buildForestPrompt, resolveModel } from "./prompts.js";
import { runClaudeStreaming, makeStreamBatcher } from "./claude.js";
import {
  ACTIONS_SENTINEL,
  MAX_ACTIONS_CAP,
  parseAiTurn,
  parseActionObjects,
  ghostPayloadFromAction,
  actionStatusLabel,
  describeDestructive,
} from "./parse.js";

const aiLocks = new Map(); // nodeId | forest:<repoId> → { child } : 1 tour IA en vol (sinon 409 ai_busy)
let aiInFlight = 0; // nb de spawns claude simultanés (sémaphore global)
const MAX_CONCURRENT_AI = 4;

// ── Actions mixtes (nœuds Vibes + entrées de SUIVI) ──────────────────────────
// Les chats IA produisent un seul flux d'actions ; les ops du domaine SUIVI sont
// appliquées par db/issues.js (scope repo), les autres par le moteur de nœuds
// (scope sous-arbre / repo). On scinde le flux puis on fusionne les deux résultats.
const ISSUE_OPS = new Set(["add_issue", "update_issue", "delete_issue", "reorder_issues"]);
const isIssueAction = (a) => !!a && ISSUE_OPS.has(a.op);
const EMPTY_ISSUE_RES = { applied: [], rejected: [], issuesChanged: false };

function mergeActionResults(nodeRes, issueRes) {
  return {
    applied: [...nodeRes.applied, ...issueRes.applied],
    rejected: [...nodeRes.rejected, ...issueRes.rejected],
    affectedNodeIds: nodeRes.affectedNodeIds || [],
    roots: nodeRes.roots || [],
    linksChanged: !!nodeRes.linksChanged,
    issuesChanged: !!issueRes.issuesChanged,
  };
}
// Applique un flux d'actions dans le scope d'un nœud (nœuds + issues du repo).
function applyMixedNodeActions(repoId, nodeId, actions) {
  const issueActions = (actions || []).filter(isIssueAction);
  const nodeActions = (actions || []).filter((a) => a && !isIssueAction(a));
  const nodeRes = applyNodeActions(nodeId, nodeActions, repoId);
  const issueRes = issueActions.length ? applyIssueActions(repoId, issueActions) : EMPTY_ISSUE_RES;
  return mergeActionResults(nodeRes, issueRes);
}
// Applique un flux d'actions au niveau forêt (nœuds + issues du repo).
function applyMixedForestActions(repoId, actions) {
  const issueActions = (actions || []).filter(isIssueAction);
  const nodeActions = (actions || []).filter((a) => a && !isIssueAction(a));
  const nodeRes = applyForestActions(repoId, nodeActions);
  const issueRes = issueActions.length ? applyIssueActions(repoId, issueActions) : EMPTY_ISSUE_RES;
  return mergeActionResults(nodeRes, issueRes);
}
// Diffuse « entrées de suivi modifiées » sur le canal forêt du repo (la vue Suivi y
// est abonnée → recharge sa liste). Best-effort.
function broadcastIssuesChanged(repoId) {
  broadcast(forestKey(repoId), "issues:changed", { repoId });
}

// Prédicats exposés au routeur (refus de vider l'historique pendant un tour IA),
// sans fuiter la Map interne.
export function nodeAiBusy(nodeId) {
  return aiLocks.has(nodeId);
}
export function forestAiBusy(repoId) {
  return aiLocks.has(forestLockKey(repoId));
}

// Mappe une erreur du pipeline IA en message FR affichable (partagé nœud/forêt).
function aiErrorMessage(e) {
  return e && e.code === "AI_TIMEOUT"
    ? "Délai dépassé : l'IA n'a pas répondu à temps."
    : e && e.code === "AI_OVERFLOW"
    ? "Réponse trop longue (tronquée), aucune action appliquée."
    : e && e.code === "ENOENT"
    ? `CLI Claude introuvable (${CLAUDE_BIN}). Vérifier MEOWTRACK_CLAUDE_BIN sur le serveur.`
    : e && e.code === "AI_RESULT_ERROR"
    ? "L'IA a renvoyé une erreur."
    : e && e.code === "AI_EXIT"
    ? "L'IA s'est interrompue (sortie anormale)."
    : (e && e.message) || "Erreur lors de l'appel à l'IA.";
}

// Dump diagnostic du bloc d'actions brut quand parseAiTurn le juge illisible
// (malformed). On isole la portion après la sentinelle (sinon tout le brut),
// tronquée, pour voir POURQUOI le JSON ne parse pas (guillemets typographiques,
// virgule traînante, troncature, "actions" absent…). \n échappés pour 1 ligne/journal.
function dumpMalformedTurn(tag, raw) {
  const s = String(raw || "");
  const i = s.indexOf(ACTIONS_SENTINEL);
  const blob = i >= 0 ? s.slice(i) : s;
  const snippet = blob.slice(0, 4000).replace(/\n/g, "\\n");
  console.error(`[meowtrack] ${tag}: BLOC ILLISIBLE (len=${blob.length}, sentinelle=${i >= 0}) → ${snippet}`);
}

// Diffuse l'event « liens de prérequis modifiés » : le graphe recharge ses liens,
// et la vue détail du nœud rafraîchit « Dépend de / Requis par ».
function broadcastLinksChanged(repoId, nodeId) {
  broadcast(forestKey(repoId), "links:changed", { repoId });
  if (nodeId != null) broadcast(nodeKey(repoId, nodeId), "links:changed", { repoId, nodeId });
}

// ── Tour de chat IA STREAMING (async, détaché ; le HTTP a déjà répondu 202) ──
async function runNodeTurn(repoId, nodeId, scopeSnapshot, descendants, history, userText, author, model, pendingId, root, repo, links, issues) {
  const batcher = makeStreamBatcher(nodeKey(repoId, nodeId), pendingId);
  let reasoning = "";
  let answer = "";
  let shownLen = 0; // longueur de `answer` déjà diffusée comme texte conversationnel
  let inActions = false; // true dès que la sentinelle d'actions est rencontrée
  let actionStatus = ""; // dernier libellé d'action diffusé (anti-doublon)
  let ghostCount = 0; // nb d'actions déjà traitées pour l'aperçu fantôme (high-water)
  // Diffuse le texte conversationnel en retenant une marge (taille sentinelle) au
  // cas où une sentinelle partielle serait en cours d'arrivée, puis bascule en
  // mode « actions » dès que la sentinelle complète apparaît.
  const pumpVisible = () => {
    const idx = answer.indexOf(ACTIONS_SENTINEL);
    let visibleEnd;
    if (idx >= 0) {
      visibleEnd = idx; // tout ce qui précède la sentinelle = conversationnel
      inActions = true;
    } else {
      visibleEnd = answer.length - ACTIONS_SENTINEL.length; // marge anti-sentinelle partielle
      if (visibleEnd < shownLen) visibleEnd = shownLen;
    }
    if (visibleEnd > shownLen) {
      batcher.push("text", answer.slice(shownLen, visibleEnd));
      shownLen = visibleEnd;
    }
  };
  // Recalcule le libellé d'action à partir des `op` déjà reçus dans le bloc JSON.
  const refreshActionStatus = () => {
    const i = answer.indexOf(ACTIONS_SENTINEL);
    if (i < 0) return;
    const ops = [...answer.slice(i).matchAll(/"op"\s*:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const label = actionStatusLabel(ops);
    if (label !== actionStatus) {
      actionStatus = label;
      batcher.push("status", label);
    }
  };
  // Aperçu « fantôme » : dès qu'un add_node complet apparaît dans le bloc JSON en
  // cours, on diffuse un nœud non persisté (node:ghost) pour que le sous-arbre se
  // construise sous les yeux. Les vrais nœuds (créés en bloc à la fin) les
  // remplaceront via le refetch. Rien n'est écrit en base ici.
  const refreshGhosts = () => {
    const i = answer.indexOf(ACTIONS_SENTINEL);
    if (i < 0) return;
    const objs = parseActionObjects(answer.slice(i)); // objets complets seulement
    for (let k = ghostCount; k < objs.length; k++) {
      const gh = ghostPayloadFromAction(objs[k], "g:" + pendingId + ":" + k);
      if (gh) broadcast(nodeKey(repoId, nodeId), "node:ghost", gh);
    }
    ghostCount = objs.length;
  };
  let switchedToStreaming = false;
  const ensureStreaming = () => {
    if (switchedToStreaming) return;
    switchedToStreaming = true;
    const m = updateNodeMessage(pendingId, { state: "streaming" }, repoId);
    broadcastMessage(repoId, nodeId, m);
  };
  try {
    const prompt = buildNodePrompt(scopeSnapshot, descendants, history, userText, author, repo, links, issues);
    const result = await runClaudeStreaming(prompt, model, root, {
      onChild: (child) => { const l = aiLocks.get(nodeId); if (l) l.child = child; },
      onThinking: (d) => {
        ensureStreaming();
        if (reasoning.length < 64 * 1024) reasoning += d; // cap réflexion
        batcher.push("thinking", d);
      },
      onText: (d) => {
        ensureStreaming();
        answer += d;
        if (!inActions) pumpVisible();
        if (inActions) { refreshActionStatus(); refreshGhosts(); }
      },
      onTool: (name, target) => {
        ensureStreaming();
        const line = `\n🔧 ${name}${target ? " " + target : ""}\n`;
        if (reasoning.length < 64 * 1024) reasoning += line;
        batcher.push("thinking", line); // l'activité (lecture de fichiers…) s'affiche dans la réflexion
      },
    });
    batcher.end();

    const raw = result || answer;
    const { text, actions, note, malformed } = parseAiTurn(raw);
    console.error(
      `[meowtrack] runNodeTurn node=${nodeId}: parse → ${(actions || []).length} action(s), malformed=${!!malformed}` +
        (actions && actions.length ? ` ops=[${actions.map((a) => a && a.op).join(",")}]` : "")
    );
    if (malformed) dumpMalformedTurn(`runNodeTurn node=${nodeId}`, raw);
    // index des tailles de sous-arbre pour l'affichage des suppressions
    const subById = new Map((descendants || []).map((n) => [n.id, 0]));
    const destructive = describeDestructive(actions, scopeSnapshot, subById);
    const baseText = text || (malformed ? "(réponse de l'IA illisible — aucune action appliquée)" : "");

    if (destructive.length) {
      const msg = updateNodeMessage(pendingId, {
        body: `${baseText}\n\n⚠️ Claude propose une action destructive (${destructive.join(", ")}) — confirmation requise.`,
        reasoning,
        state: "complete",
        actions: [{ proposed: true, ops: actions.slice(0, MAX_ACTIONS_CAP), note }],
      }, repoId);
      broadcastMessage(repoId, nodeId, msg);
      return;
    }

    const applied = applyMixedNodeActions(repoId, nodeId, actions);
    console.error(
      `[meowtrack] runNodeTurn node=${nodeId}: ${applied.applied.length} appliquée(s), ${applied.rejected.length} rejetée(s)` +
        (applied.rejected.length ? ` → rejets: ${JSON.stringify(applied.rejected)}` : "")
    );
    const summary = applied.applied.length ? [{ applied: true, ops: applied.applied, note }] : [];
    const body = baseText || (applied.applied.length ? note || "Modifications appliquées." : "");
    const msg = updateNodeMessage(pendingId, { body, reasoning, state: "complete", actions: summary }, repoId);
    broadcastMessage(repoId, nodeId, msg);
    broadcastAffected(repoId, applied.affectedNodeIds);
    if (applied.linksChanged) broadcastLinksChanged(repoId, nodeId); // l'IA a (dé)lié des prérequis
    if (applied.issuesChanged) broadcastIssuesChanged(repoId); // l'IA a créé/modifié des entrées de suivi
  } catch (e) {
    batcher.end();
    const emsg = aiErrorMessage(e);
    try {
      const msg = updateNodeMessage(pendingId, { body: emsg, reasoning, state: "error" }, repoId);
      broadcastMessage(repoId, nodeId, msg);
    } catch {
      /* ignore */
    }
  } finally {
    aiLocks.delete(nodeId);
    aiInFlight = Math.max(0, aiInFlight - 1);
    broadcast(nodeKey(repoId, nodeId), "ai:turn", { nodeId, state: "end", turnId: pendingId });
  }
}

// POST /api/nodes/:ref/chat — persiste le message humain + un placeholder IA
// `pending`, répond 202, puis lance le tour IA streaming en tâche de fond (SSE).
export async function handleNodeChat(req, res, node) {
  const body = await readBody(req);
  const text = String(body.body || "").trim();
  if (!text) return send(res, 400, { error: "Message vide" });
  const author = String(body.author || "anon").slice(0, 60) || "anon";
  const model = resolveModel(body.model);
  const clientNonce = body.clientNonce ? String(body.clientNonce).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || null : null;

  if (aiLocks.has(node.id)) return send(res, 409, { error: "ai_busy" });
  if (aiInFlight >= MAX_CONCURRENT_AI) return send(res, 429, { error: "ai_overloaded" });

  const repoId = node.repoId;
  const userMessage = addNodeMessage(node.id, { role: "user", author, body: text, state: "complete", clientNonce }, repoId);
  broadcastMessage(repoId, node.id, userMessage);

  const pendingMessage = addNodeMessage(node.id, { role: "assistant", author: "claude", model, body: "", state: "pending" }, repoId);
  broadcastMessage(repoId, node.id, pendingMessage);

  // Snapshot (nœud + sous-arbre) + historique FIGÉS avant lock/202.
  const sub = getSubtree(node.id, { repoId });
  const snapshot = sub ? sub.node : getNode(node.id, { repoId });
  const descendants = sub ? sub.descendants : [];
  // Liens de prérequis internes au sous-arbre (contexte du prompt).
  const subtreeIds = new Set([snapshot.id, ...descendants.map((d) => d.id)]);
  let links = [];
  try {
    links = listForestLinks(repoId).filter((l) => subtreeIds.has(l.fromId) && subtreeIds.has(l.toId));
  } catch { /* pas de liens → prompt sans bloc */ }
  // Snapshot des entrées de suivi du repo (contexte pour update/delete/reorder issues).
  let issues = [];
  try {
    issues = listIssues(repoId, { includeClosed: true, limit: 200 });
  } catch { /* pas d'issues → prompt sans bloc */ }
  const history = listNodeMessages(node.id, { limit: 1000, repoId }).filter((m) => m.state === "complete" && m.id !== userMessage.id);

  aiLocks.set(node.id, { child: null }); // atomique (pas d'await entre check et set)
  aiInFlight++;
  broadcast(nodeKey(repoId, node.id), "ai:turn", { nodeId: node.id, actor: author, model, state: "start", turnId: pendingMessage.id });

  // Clone du repo du nœud → cwd de l'IA (lecture du code réel, multi-repos).
  let root = null;
  try {
    root = rootForRepo(node.repoId);
  } catch {
    /* repo sans clone résolvable → IA sans accès fichiers */
  }
  // Métadonnées du repo (nom/slug) pour nommer le projet dans le prompt (multi-repos).
  let repo = null;
  try {
    repo = getRepo(node.repoId);
  } catch {
    /* repo introuvable → libellé générique dans le prompt */
  }
  send(res, 202, { userMessage, pendingMessage });
  runNodeTurn(repoId, node.id, snapshot, descendants, history, text, author, model, pendingMessage.id, root, repo, links, issues).catch(() => {});
}

// POST /api/nodes/:ref/chat/confirm { messageId } — applique une proposition
// destructive (mode confirmation). Premier clic de n'importe quel participant.
export function handleNodeChatConfirm(req, res, node, body) {
  const repoId = node.repoId;
  const messageId = Number(body.messageId);
  const msg = getNodeMessage(messageId, repoId);
  if (!msg || msg.nodeId !== node.id) return send(res, 404, { error: "not_found" });
  const proposal = Array.isArray(msg.actions) ? msg.actions.find((a) => a && a.proposed) : null;
  if (!proposal) return send(res, 400, { error: "Aucune proposition à confirmer" });
  const result = applyMixedNodeActions(repoId, node.id, proposal.ops || []);
  const cleaned = String(msg.body || "").replace(/⚠️[\s\S]*$/u, "").trim();
  const updated = updateNodeMessage(messageId, {
    body: `${cleaned}\n\n✅ ${result.applied.length} action(s) confirmée(s).`,
    actions: [{ applied: true, ops: result.applied, note: proposal.note || "" }],
  }, repoId);
  broadcastMessage(repoId, node.id, updated);
  broadcastAffected(repoId, result.affectedNodeIds);
  if (result.linksChanged) broadcastLinksChanged(repoId, node.id);
  if (result.issuesChanged) broadcastIssuesChanged(repoId);
  return send(res, 200, { ok: true, applied: result.applied });
}

// ── Chat « top level » (forêt d'un repo) ─────────────────────────────────────
// Même pipeline que le chat par nœud, scopé sur le repo entier. Verrou keyé par la
// chaîne `forest:<repoId>` (jamais en collision avec les ids numériques de nœuds).
const forestLockKey = (repoId) => `forest:${repoId}`;

// Vrai si l'application d'actions a changé la STRUCTURE (suppression/déplacement/
// réordonnancement) → on force un rechargement de la forêt côté clients (broadcastAffected
// seul ne reflète pas les suppressions ni l'ordre des racines).
function forestStructuralChange(applied) {
  return (applied || []).some((a) => a && (a.op === "delete_node" || a.op === "move_node" || a.op === "reorder_children"));
}

async function runForestTurn(repoId, forestSnapshot, history, userText, author, model, pendingId, root, links, issues) {
  const room = forestKey(repoId);
  const batcher = makeStreamBatcher(room, pendingId);
  let reasoning = "";
  let answer = "";
  let shownLen = 0;
  let inActions = false;
  let actionStatus = "";
  const pumpVisible = () => {
    const idx = answer.indexOf(ACTIONS_SENTINEL);
    let visibleEnd;
    if (idx >= 0) {
      visibleEnd = idx;
      inActions = true;
    } else {
      visibleEnd = answer.length - ACTIONS_SENTINEL.length;
      if (visibleEnd < shownLen) visibleEnd = shownLen;
    }
    if (visibleEnd > shownLen) {
      batcher.push("text", answer.slice(shownLen, visibleEnd));
      shownLen = visibleEnd;
    }
  };
  const refreshActionStatus = () => {
    const i = answer.indexOf(ACTIONS_SENTINEL);
    if (i < 0) return;
    const ops = [...answer.slice(i).matchAll(/"op"\s*:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const label = actionStatusLabel(ops);
    if (label !== actionStatus) {
      actionStatus = label;
      batcher.push("status", label);
    }
  };
  // Aperçu « fantôme » pour le graphe/grille de la forêt : chaque add_node complet
  // est diffusé (node:ghost) avant persistance. parentId (id réel) / parentKey (réf
  // tmpKey) permettent au front de nicher les sous-jalons sous leur parent fantôme.
  let ghostCount = 0;
  const refreshGhosts = () => {
    const i = answer.indexOf(ACTIONS_SENTINEL);
    if (i < 0) return;
    const objs = parseActionObjects(answer.slice(i));
    for (let k = ghostCount; k < objs.length; k++) {
      const gh = ghostPayloadFromAction(objs[k], "g:" + pendingId + ":" + k);
      if (gh) broadcast(room, "node:ghost", gh);
    }
    ghostCount = objs.length;
  };
  let switchedToStreaming = false;
  const ensureStreaming = () => {
    if (switchedToStreaming) return;
    switchedToStreaming = true;
    const m = updateForestMessage(pendingId, { state: "streaming" });
    broadcastForestMessage(repoId, m);
  };
  let repo = null;
  try {
    repo = getRepo(repoId); // nom/slug du dépôt pour nommer le projet dans le prompt
  } catch {
    /* repo introuvable → libellé générique */
  }
  try {
    const prompt = buildForestPrompt(forestSnapshot, history, userText, author, repo, links, issues);
    const result = await runClaudeStreaming(prompt, model, root, {
      onChild: (child) => { const l = aiLocks.get(forestLockKey(repoId)); if (l) l.child = child; },
      onThinking: (d) => {
        ensureStreaming();
        if (reasoning.length < 64 * 1024) reasoning += d;
        batcher.push("thinking", d);
      },
      onText: (d) => {
        ensureStreaming();
        answer += d;
        if (!inActions) pumpVisible();
        if (inActions) { refreshActionStatus(); refreshGhosts(); }
      },
      onTool: (name, target) => {
        ensureStreaming();
        const line = `\n🔧 ${name}${target ? " " + target : ""}\n`;
        if (reasoning.length < 64 * 1024) reasoning += line;
        batcher.push("thinking", line);
      },
    });
    batcher.end();

    const raw = result || answer;
    const { text, actions, note, malformed } = parseAiTurn(raw);
    console.error(
      `[meowtrack] runForestTurn repo=${repoId}: parse → ${(actions || []).length} action(s), malformed=${!!malformed}` +
        (actions && actions.length ? ` ops=[${actions.map((a) => a && a.op).join(",")}]` : "")
    );
    if (malformed) dumpMalformedTurn(`runForestTurn repo=${repoId}`, raw);
    const subById = new Map((forestSnapshot || []).map((n) => [n.id, 0]));
    const destructive = describeDestructive(actions, null, subById);
    const baseText = text || (malformed ? "(réponse de l'IA illisible — aucune action appliquée)" : "");

    if (destructive.length) {
      const msg = updateForestMessage(pendingId, {
        body: `${baseText}\n\n⚠️ Claude propose une action destructive (${destructive.join(", ")}) — confirmation requise.`,
        reasoning,
        state: "complete",
        actions: [{ proposed: true, ops: actions.slice(0, MAX_ACTIONS_CAP), note }],
      }, repoId);
      broadcastForestMessage(repoId, msg);
      return;
    }

    const applied = applyMixedForestActions(repoId, actions);
    console.error(
      `[meowtrack] runForestTurn repo=${repoId}: ${applied.applied.length} appliquée(s), ${applied.rejected.length} rejetée(s)` +
        (applied.rejected.length ? ` → rejets: ${JSON.stringify(applied.rejected)}` : "")
    );
    const summary = applied.applied.length ? [{ applied: true, ops: applied.applied, note }] : [];
    const body = baseText || (applied.applied.length ? note || "Modifications appliquées." : "");
    const msg = updateForestMessage(pendingId, { body, reasoning, state: "complete", actions: summary }, repoId);
    broadcastForestMessage(repoId, msg);
    broadcastAffected(repoId, applied.affectedNodeIds);
    if (forestStructuralChange(applied.applied)) broadcast(room, "nodes:reordered", { forest: true });
    if (applied.linksChanged) broadcast(room, "links:changed", { repoId });
    if (applied.issuesChanged) broadcastIssuesChanged(repoId);
  } catch (e) {
    batcher.end();
    const emsg = aiErrorMessage(e);
    try {
      const msg = updateForestMessage(pendingId, { body: emsg, reasoning, state: "error" }, repoId);
      broadcastForestMessage(repoId, msg);
    } catch {
      /* ignore */
    }
  } finally {
    aiLocks.delete(forestLockKey(repoId));
    aiInFlight = Math.max(0, aiInFlight - 1);
    broadcast(room, "ai:turn", { repoId, scope: "forest", state: "end", turnId: pendingId });
  }
}

// POST /api/forest/chat — chat « top level » : persiste le message humain + un
// placeholder IA `pending`, répond 202, puis lance le tour IA streaming en fond.
// `body` est déjà lu par le routeur (readBody ne se consomme qu'une fois).
export function handleForestChat(res, repoId, body) {
  const text = String(body.body || "").trim();
  if (!text) return send(res, 400, { error: "Message vide" });
  const author = String(body.author || "anon").slice(0, 60) || "anon";
  const model = resolveModel(body.model);
  const clientNonce = body.clientNonce ? String(body.clientNonce).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || null : null;

  const lockKey = forestLockKey(repoId);
  if (aiLocks.has(lockKey)) return send(res, 409, { error: "ai_busy" });
  if (aiInFlight >= MAX_CONCURRENT_AI) return send(res, 429, { error: "ai_overloaded" });

  const userMessage = addForestMessage(repoId, { role: "user", author, body: text, state: "complete", clientNonce });
  broadcastForestMessage(repoId, userMessage);

  const pendingMessage = addForestMessage(repoId, { role: "assistant", author: "claude", model, body: "", state: "pending" });
  broadcastForestMessage(repoId, pendingMessage);

  // Snapshot (toute la forêt + liens) + historique FIGÉS avant lock/202.
  const forestSnapshot = listForest(repoId);
  let forestLinks = [];
  try { forestLinks = listForestLinks(repoId); } catch { /* pas de liens */ }
  let issues = [];
  try { issues = listIssues(repoId, { includeClosed: true, limit: 200 }); } catch { /* pas d'issues */ }
  const history = listForestMessages(repoId, { limit: 1000 }).filter((m) => m.state === "complete" && m.id !== userMessage.id);

  aiLocks.set(lockKey, { child: null });
  aiInFlight++;
  broadcast(forestKey(repoId), "ai:turn", { repoId, scope: "forest", actor: author, model, state: "start", turnId: pendingMessage.id });

  let root = null;
  try {
    root = rootForRepo(repoId);
  } catch {
    /* repo sans clone résolvable → IA sans accès fichiers */
  }
  send(res, 202, { userMessage, pendingMessage });
  runForestTurn(repoId, forestSnapshot, history, text, author, model, pendingMessage.id, root, forestLinks, issues).catch(() => {});
}

// POST /api/forest/chat/confirm { messageId } — confirme une proposition destructive
// du chat « top level ».
export function handleForestChatConfirm(req, res, repoId, body) {
  const messageId = Number(body.messageId);
  const msg = getForestMessage(messageId, repoId);
  if (!msg || msg.repoId !== repoId) return send(res, 404, { error: "not_found" });
  const proposal = Array.isArray(msg.actions) ? msg.actions.find((a) => a && a.proposed) : null;
  if (!proposal) return send(res, 400, { error: "Aucune proposition à confirmer" });
  const result = applyMixedForestActions(repoId, proposal.ops || []);
  const cleaned = String(msg.body || "").replace(/⚠️[\s\S]*$/u, "").trim();
  const updated = updateForestMessage(messageId, {
    body: `${cleaned}\n\n✅ ${result.applied.length} action(s) confirmée(s).`,
    actions: [{ applied: true, ops: result.applied, note: proposal.note || "" }],
  }, repoId);
  broadcastForestMessage(repoId, updated);
  broadcastAffected(repoId, result.affectedNodeIds);
  if (forestStructuralChange(result.applied)) broadcast(forestKey(repoId), "nodes:reordered", { forest: true });
  if (result.linksChanged) broadcast(forestKey(repoId), "links:changed", { repoId });
  if (result.issuesChanged) broadcastIssuesChanged(repoId);
  return send(res, 200, { ok: true, applied: result.applied });
}
