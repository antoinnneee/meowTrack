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
  deleteNode,
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
  listReviews,
  resolveReview,
  listRuns,
  bumpAutoReviews,
  listIssues,
  applyIssueActions,
  nextQueuedNodeTurn,
  listQueuedNodeIds,
  failDanglingNodeTurns,
  nextQueuedForestTurn,
  hasQueuedForestTurn,
  failDanglingForestTurns,
  listRepos,
} from "../db.js";
import { MAX_AUTO_REVIEWS } from "../db/constants.js";
import { send, readBody } from "../http-util.js";
import {
  forestKey,
  nodeKey,
  broadcast,
  broadcastMessage,
  broadcastForestMessage,
  broadcastAffected,
  refreshAncestors,
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
const ISSUE_OPS = new Set(["add_issue", "update_issue", "delete_issue", "reorder_issues", "link_issue", "unlink_issue"]);
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

// Interrompt le tour IA en cours : marque le verrou « stopped » (pour finaliser le
// message proprement, sans erreur) puis tue le process CLI. Le SIGKILL fait remonter
// child.on('close') → catch du runner, qui voit le flag et clôt en état « interrompu ».
function stopLock(key) {
  const l = aiLocks.get(key);
  if (!l || !l.child) return false;
  l.stopped = true;
  try { l.child.kill("SIGKILL"); } catch { /* déjà mort */ }
  return true;
}
export function stopNodeTurn(nodeId) {
  return stopLock(nodeId);
}
export function stopForestTurn(repoId) {
  return stopLock(forestLockKey(repoId));
}

// Extrait le motif brut d'une erreur du pipeline IA (result d'erreur du CLI ou
// tail stderr), tronqué pour rester affichable/journalisable sur une ligne.
function aiErrorDetail(e) {
  const raw = (e && (e.detail || e.stderr)) || "";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 500);
}

// Mappe une erreur du pipeline IA en message FR affichable (partagé nœud/forêt).
// Pour les erreurs renvoyées par le CLI (AI_RESULT_ERROR / AI_EXIT), on annexe le
// motif brut quand il existe — sinon l'utilisateur n'a aucune piste (« pas de log »).
function aiErrorMessage(e) {
  const detail = aiErrorDetail(e);
  return e && e.code === "AI_TIMEOUT"
    ? "Délai dépassé : l'IA n'a pas répondu à temps."
    : e && e.code === "AI_OVERFLOW"
    ? "Réponse trop longue (tronquée), aucune action appliquée."
    : e && e.code === "ENOENT"
    ? `CLI Claude introuvable (${CLAUDE_BIN}). Vérifier MEOWTRACK_CLAUDE_BIN sur le serveur.`
    : e && e.code === "AI_RESULT_ERROR"
    ? detail ? `L'IA a renvoyé une erreur : ${detail}` : "L'IA a renvoyé une erreur."
    : e && e.code === "AI_EXIT"
    ? detail ? `L'IA s'est interrompue (sortie anormale) : ${detail}` : "L'IA s'est interrompue (sortie anormale)."
    : (e && e.message) || "Erreur lors de l'appel à l'IA.";
}

// Journalise une erreur du pipeline IA côté serveur (code + motif brut), pour que
// la cause apparaisse dans les logs même quand le message affiché reste générique.
function logAiError(tag, e) {
  const detail = aiErrorDetail(e);
  console.error(
    `[meowtrack] ${tag}: ${(e && e.code) || "ERR"}` +
      (e && e.exitCode != null ? ` (exit=${e.exitCode})` : "") +
      (detail ? ` → ${detail}` : (e && e.message ? ` → ${e.message}` : ""))
  );
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
    // Interruption volontaire (bouton Stop) : on finalise sans erreur, en gardant
    // le texte déjà streamé. Aucune action appliquée (le bloc peut être incomplet).
    if (aiLocks.get(nodeId)?.stopped) {
      const partial = answer.split(ACTIONS_SENTINEL)[0].trim();
      try {
        const msg = updateNodeMessage(pendingId, { body: partial ? `${partial}\n\n⏹️ _(interrompu)_` : "⏹️ Réponse interrompue.", reasoning, state: "complete", actions: [] }, repoId);
        broadcastMessage(repoId, nodeId, msg);
      } catch { /* ignore */ }
    } else {
      logAiError(`runNodeTurn nœud ${nodeId}`, e);
      const emsg = aiErrorMessage(e);
      try {
        const msg = updateNodeMessage(pendingId, { body: emsg, reasoning, state: "error" }, repoId);
        broadcastMessage(repoId, nodeId, msg);
      } catch {
        /* ignore */
      }
    }
  } finally {
    aiLocks.delete(nodeId);
    aiInFlight = Math.max(0, aiInFlight - 1);
    broadcast(nodeKey(repoId, nodeId), "ai:turn", { nodeId, state: "end", turnId: pendingId });
    drainNodeQueue(repoId, nodeId); // Option B : enchaîne le prochain tour en file (NODE-329)
  }
}

// ── File persistée des tours IA — versant nœud (Option B, NODE-329) ──────────
// Démarre (ou enchaîne) un tour IA pour un nœud : fige les snapshots, prend le verrou,
// diffuse `start`, puis lance runNodeTurn détaché. `pendingMessage` est le placeholder
// assistant DÉJÀ persisté (créé `pending` à chaud, ou réhydraté depuis `queued` au
// drain) ; `triggerUserId` (le message humain du tour) est exclu de l'historique car
// il est passé à part au prompt.
function startNodeTurn(node, repoId, text, author, model, sessionId, pendingMessage, triggerUserId) {
  const sub = getSubtree(node.id, { repoId });
  const snapshot = sub ? sub.node : getNode(node.id, { repoId });
  const descendants = sub ? sub.descendants : [];
  const subtreeIds = new Set([snapshot.id, ...descendants.map((d) => d.id)]);
  let links = [];
  try {
    links = listForestLinks(repoId).filter((l) => subtreeIds.has(l.fromId) && subtreeIds.has(l.toId));
  } catch { /* pas de liens → prompt sans bloc */ }
  let issues = [];
  try {
    issues = listIssues(repoId, { includeClosed: true, limit: 200 });
  } catch { /* pas d'issues → prompt sans bloc */ }
  const history = listNodeMessages(node.id, { limit: 1000, repoId, sessionId }).filter((m) => m.state === "complete" && m.id !== triggerUserId);

  aiLocks.set(node.id, { child: null }); // atomique (pas d'await entre check et set)
  aiInFlight++;
  broadcast(nodeKey(repoId, node.id), "ai:turn", { nodeId: node.id, actor: author, model, state: "start", turnId: pendingMessage.id });

  let root = null;
  try { root = rootForRepo(repoId); } catch { /* repo sans clone → IA sans accès fichiers */ }
  let repo = null;
  try { repo = getRepo(repoId); } catch { /* repo introuvable → libellé générique */ }
  runNodeTurn(repoId, node.id, snapshot, descendants, history, text, author, model, pendingMessage.id, root, repo, links, issues).catch(() => {});
}

// Enchaîne le prochain tour en file d'un nœud. Appelé au finally du tour précédent
// (verrou déjà libéré) et au boot (reprise). Best-effort : aucune erreur ne casse la
// chaîne. Réhydrate le placeholder `queued` → `pending`, puis démarre.
function drainNodeQueue(repoId, nodeId) {
  try {
    if (aiLocks.has(nodeId)) return; // un tour est déjà en vol
    if (aiInFlight >= MAX_CONCURRENT_AI) return; // sémaphore saturé → repris à la prochaine clôture / au boot
    const turn = nextQueuedNodeTurn(nodeId, repoId);
    if (!turn || !turn.assistant) return;
    const node = getNode(nodeId, { repoId });
    if (!node) return;
    // Texte déclencheur absent (message source purgé) → on marque le placeholder en
    // erreur et on tente le suivant, pour ne pas bloquer la file.
    if (!turn.user || !turn.user.body) {
      try {
        updateNodeMessage(turn.assistant.id, { state: "error", body: "Message en file orphelin (source introuvable)." }, repoId);
        broadcastMessage(repoId, nodeId, getNodeMessage(turn.assistant.id, repoId));
      } catch { /* ignore */ }
      return drainNodeQueue(repoId, nodeId);
    }
    const m = updateNodeMessage(turn.assistant.id, { state: "pending" }, repoId);
    broadcastMessage(repoId, nodeId, m);
    startNodeTurn(node, repoId, turn.user.body, turn.user.author, turn.assistant.model, turn.assistant.sessionId, m, turn.user.id);
  } catch (e) {
    console.error(`[meowtrack] drainNodeQueue node=${nodeId}: ${e.message || e}`);
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
  const sessionId = Number(body.session) || 0; // 0 = conversation par défaut
  const clientNonce = body.clientNonce ? String(body.clientNonce).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || null : null;

  const repoId = node.repoId;
  const busy = aiLocks.has(node.id);
  // Option B (NODE-329) : si un tour est DÉJÀ en vol pour ce nœud, on ENFILE le
  // message (placeholder assistant `queued`) au lieu de renvoyer 409 — il sera
  // enchaîné à la clôture du tour courant (drainNodeQueue). Le 429 (sémaphore global
  // saturé) ne s'applique qu'au démarrage à froid : sinon une file existe pour reprendre.
  if (!busy && aiInFlight >= MAX_CONCURRENT_AI) return send(res, 429, { error: "ai_overloaded" });

  const userMessage = addNodeMessage(node.id, { role: "user", author, body: text, state: "complete", clientNonce, sessionId }, repoId);
  broadcastMessage(repoId, node.id, userMessage);

  const pendingMessage = addNodeMessage(node.id, { role: "assistant", author: "claude", model, body: "", state: busy ? "queued" : "pending", sessionId }, repoId);
  broadcastMessage(repoId, node.id, pendingMessage);

  if (busy) return send(res, 202, { userMessage, pendingMessage, queued: true });

  send(res, 202, { userMessage, pendingMessage });
  startNodeTurn(node, repoId, text, author, model, sessionId, pendingMessage, userMessage.id);
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

// ── Annulation du « placement » d'un message IA ──────────────────────────────
// Supprime les nœuds CRÉÉS par un message (ops add_node appliquées et auto-validées).
// Seules les créations sont réversibles proprement (suppression = cascade) ; les
// mises à jour/déplacements/réordonnancements ne sont pas annulés. Idempotent : un
// nœud déjà supprimé (cascade d'un parent créé par le même message) est ignoré.

// Extrait l'entrée d'actions appliquées non encore annulée + les ids créés (add_node).
function appliedCreatedIds(msg) {
  const actions = Array.isArray(msg && msg.actions) ? msg.actions : [];
  const idx = actions.findIndex((a) => a && a.applied && !a.undone);
  const entry = idx >= 0 ? actions[idx] : null;
  const ids = entry ? (entry.ops || []).filter((o) => o && o.op === "add_node" && o.id != null).map((o) => o.id) : [];
  return { idx, ids };
}
// Supprime les ids créés et diffuse les events ; renvoie la liste réellement supprimée.
function deleteCreatedNodes(repoId, ids) {
  const deleted = [];
  const parents = new Set();
  for (const id of ids) {
    if (!getNode(id, { repoId })) continue; // déjà parti (cascade)
    const r = deleteNode(id, repoId);
    deleted.push(id);
    const payload = { id, parentId: r.parentId, rootId: r.rootId };
    broadcast(nodeKey(repoId, id), "node:deleted", payload);
    broadcast(forestKey(repoId), "node:deleted", payload);
    if (r.parentId != null) { broadcast(nodeKey(repoId, r.parentId), "node:deleted", payload); parents.add(r.parentId); }
  }
  for (const p of parents) refreshAncestors(repoId, p, p);
  return deleted;
}

// POST /api/nodes/:ref/chat/:msgId/undo — annule le placement d'un message du nœud.
export function handleNodeChatUndo(req, res, node, msgId) {
  const repoId = node.repoId;
  if (nodeAiBusy(node.id)) return send(res, 409, { error: "ai_busy" });
  const msg = getNodeMessage(Number(msgId), repoId);
  if (!msg || msg.nodeId !== node.id) return send(res, 404, { error: "not_found" });
  const { idx, ids } = appliedCreatedIds(msg);
  if (!ids.length) return send(res, 400, { error: "rien_a_annuler" });
  const deleted = deleteCreatedNodes(repoId, ids);
  const updated = updateNodeMessage(msg.id, {
    body: `${String(msg.body || "").trim()}\n\n↩️ _Placement annulé (${deleted.length} nœud(s) supprimé(s))._`,
    actions: msg.actions.map((a, i) => (i === idx ? { ...a, undone: true } : a)),
  }, repoId);
  broadcastMessage(repoId, node.id, updated);
  return send(res, 200, { ok: true, deleted });
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

async function runForestTurn(repoId, forestSnapshot, history, userText, author, model, pendingId, root, links, issues, policyPrompt = "") {
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
    const prompt = buildForestPrompt(forestSnapshot, history, userText, author, repo, links, issues, policyPrompt);
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
    if (aiLocks.get(forestLockKey(repoId))?.stopped) {
      const partial = answer.split(ACTIONS_SENTINEL)[0].trim();
      try {
        const msg = updateForestMessage(pendingId, { body: partial ? `${partial}\n\n⏹️ _(interrompu)_` : "⏹️ Réponse interrompue.", reasoning, state: "complete", actions: [] }, repoId);
        broadcastForestMessage(repoId, msg);
      } catch { /* ignore */ }
    } else {
      logAiError(`runForestTurn repo ${repoId}`, e);
      const emsg = aiErrorMessage(e);
      try {
        const msg = updateForestMessage(pendingId, { body: emsg, reasoning, state: "error" }, repoId);
        broadcastForestMessage(repoId, msg);
      } catch {
        /* ignore */
      }
    }
  } finally {
    aiLocks.delete(forestLockKey(repoId));
    aiInFlight = Math.max(0, aiInFlight - 1);
    broadcast(room, "ai:turn", { repoId, scope: "forest", state: "end", turnId: pendingId });
    drainForestQueue(repoId); // Option B : enchaîne le prochain tour en file (NODE-329)
  }
}

// ── File persistée des tours IA — versant forêt (Option B, NODE-329) ─────────
// Démarre (ou enchaîne) un tour IA forêt : fige le snapshot, prend le verrou, diffuse
// `start`, lance runForestTurn détaché. `pendingMessage` est le placeholder assistant
// déjà persisté ; `triggerUserId` (le message humain) est exclu de l'historique.
function startForestTurn(repoId, text, author, model, sessionId, pendingMessage, triggerUserId) {
  const forestSnapshot = listForest(repoId);
  let forestLinks = [];
  try { forestLinks = listForestLinks(repoId); } catch { /* pas de liens */ }
  let issues = [];
  try { issues = listIssues(repoId, { includeClosed: true, limit: 200 }); } catch { /* pas d'issues */ }
  const history = listForestMessages(repoId, { limit: 1000, sessionId }).filter((m) => m.state === "complete" && m.id !== triggerUserId);

  aiLocks.set(forestLockKey(repoId), { child: null });
  aiInFlight++;
  broadcast(forestKey(repoId), "ai:turn", { repoId, scope: "forest", actor: author, model, state: "start", turnId: pendingMessage.id });

  let root = null;
  try { root = rootForRepo(repoId); } catch { /* IA sans accès fichiers */ }
  runForestTurn(repoId, forestSnapshot, history, text, author, model, pendingMessage.id, root, forestLinks, issues).catch(() => {});
}

// Enchaîne le prochain tour en file d'une forêt. Best-effort, même contrat que
// drainNodeQueue. Réhydrate le placeholder `queued` → `pending`, puis démarre.
function drainForestQueue(repoId) {
  try {
    if (aiLocks.has(forestLockKey(repoId))) return;
    if (aiInFlight >= MAX_CONCURRENT_AI) return;
    const turn = nextQueuedForestTurn(repoId);
    if (!turn || !turn.assistant) return;
    if (!turn.user || !turn.user.body) {
      try {
        updateForestMessage(turn.assistant.id, { state: "error", body: "Message en file orphelin (source introuvable)." }, repoId);
        broadcastForestMessage(repoId, getForestMessage(turn.assistant.id, repoId));
      } catch { /* ignore */ }
      return drainForestQueue(repoId);
    }
    const m = updateForestMessage(turn.assistant.id, { state: "pending" }, repoId);
    broadcastForestMessage(repoId, m);
    startForestTurn(repoId, turn.user.body, turn.user.author, turn.assistant.model, turn.assistant.sessionId, m, turn.user.id);
  } catch (e) {
    console.error(`[meowtrack] drainForestQueue repo=${repoId}: ${e.message || e}`);
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
  const sessionId = Number(body.session) || 0; // 0 = conversation par défaut
  const clientNonce = body.clientNonce ? String(body.clientNonce).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || null : null;

  const lockKey = forestLockKey(repoId);
  const busy = aiLocks.has(lockKey);
  // Option B (NODE-329) : tour forêt déjà en vol → on ENFILE au lieu de 409.
  if (!busy && aiInFlight >= MAX_CONCURRENT_AI) return send(res, 429, { error: "ai_overloaded" });

  const userMessage = addForestMessage(repoId, { role: "user", author, body: text, state: "complete", clientNonce, sessionId });
  broadcastForestMessage(repoId, userMessage);

  const pendingMessage = addForestMessage(repoId, { role: "assistant", author: "claude", model, body: "", state: busy ? "queued" : "pending", sessionId });
  broadcastForestMessage(repoId, pendingMessage);

  if (busy) return send(res, 202, { userMessage, pendingMessage, queued: true });

  send(res, 202, { userMessage, pendingMessage });
  startForestTurn(repoId, text, author, model, sessionId, pendingMessage, userMessage.id);
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

// POST /api/forest/chat/:msgId/undo — annule le placement d'un message de la forêt.
export function handleForestChatUndo(req, res, repoId, msgId) {
  if (forestAiBusy(repoId)) return send(res, 409, { error: "ai_busy" });
  const msg = getForestMessage(Number(msgId), repoId);
  if (!msg || msg.repoId !== repoId) return send(res, 404, { error: "not_found" });
  const { idx, ids } = appliedCreatedIds(msg);
  if (!ids.length) return send(res, 400, { error: "rien_a_annuler" });
  const deleted = deleteCreatedNodes(repoId, ids);
  if (deleted.length) broadcast(forestKey(repoId), "nodes:reordered", { forest: true });
  const updated = updateForestMessage(msg.id, {
    body: `${String(msg.body || "").trim()}\n\n↩️ _Placement annulé (${deleted.length} nœud(s) supprimé(s))._`,
    actions: msg.actions.map((a, i) => (i === idx ? { ...a, undone: true } : a)),
  }, repoId);
  broadcastForestMessage(repoId, updated);
  return send(res, 200, { ok: true, deleted });
}

// ── Auto-revue par le chat IA « top level » (§6.6) ───────────────────────────
// Construit le MESSAGE SYNTHÉTIQUE (untrusted) à partir du contexte de revue : le
// nœud d'origine, les points de revue ouverts (message/type/blocage/actions
// suggérées) et le résumé du dernier run. La POLITIQUE (trusted) est passée à part
// (injectée hors bloc untrusted par buildForestPrompt).
function buildReviewMessage(node, reviews, lastRun) {
  const lines = [];
  lines.push(`Une tâche d'exécution a soulevé des points de revue à arbitrer en remodelant l'arbre d'objectifs si besoin.`);
  lines.push(`Tâche : ${node.ref} — ${node.title} (statut ${node.status}).`);
  if (lastRun) {
    lines.push(`Dernier run : état=${lastRun.state}, test=${lastRun.testResult || "n/a"}${lastRun.branch ? `, branche=${lastRun.branch}` : ""}.`);
    if (lastRun.summary) lines.push(`Résumé de l'agent : ${String(lastRun.summary).slice(0, 1500)}`);
  }
  lines.push("");
  lines.push("POINTS DE REVUE :");
  for (const r of reviews) {
    lines.push(`- [${r.kind}${r.blocking ? ", BLOQUANT" : ""}] ${r.message}`);
    if (Array.isArray(r.suggested) && r.suggested.length) {
      lines.push(`  (actions suggérées par l'agent : ${JSON.stringify(r.suggested).slice(0, 1000)})`);
    }
  }
  lines.push("");
  lines.push(
    "Décide des modifications du graphe d'objectifs en réponse (créer/découper des sous-tâches, ajuster des statuts, " +
      "ajouter des prérequis, etc.) via les actions structurées. Si rien ne doit changer, explique-le sans bloc d'actions."
  );
  return lines.join("\n");
}

// Lance une auto-revue (programmatique, pas d'humain). Anti-boucle : compteur
// d'auto-revues par nœud plafonné (au-delà → on laisse la revue à un humain).
// Réutilise INTÉGRALEMENT le pipeline du chat forêt (runForestTurn → parse
// fail-closed → applyForestActions, destructif → proposé). Après le tour, marque
// les points de revue traités comme résolus (la promotion review→done est gérée par
// resolveReview quand plus aucun point bloquant ne reste). Renvoie un récapitulatif.
export async function triggerAutoReview(repoId, nodeId, reviewIds, { model, policyPrompt } = {}) {
  const lockKey = forestLockKey(repoId);
  if (aiLocks.has(lockKey)) return { error: "ai_busy" };
  if (aiInFlight >= MAX_CONCURRENT_AI) return { error: "ai_overloaded" };

  // Contexte de revue (points OUVERTS du nœud, restreints à reviewIds si fourni).
  let reviews = listReviews({ ref: nodeId, state: "open", repoId });
  if (Array.isArray(reviewIds) && reviewIds.length) reviews = reviews.filter((r) => reviewIds.includes(r.id));
  if (!reviews.length) return { skipped: "no_open_reviews" };

  // Anti-boucle : plafonner les auto-revues par nœud.
  const count = bumpAutoReviews(nodeId, repoId);
  if (count > MAX_AUTO_REVIEWS) return { skipped: "max_auto_reviews", count };

  const node = getNode(nodeId, { repoId });
  if (!node) return { skipped: "node_introuvable" };
  const runs = listRuns(nodeId, repoId);
  const mdl = resolveModel(model);
  const syntheticText = buildReviewMessage(node, reviews, runs[0] || null);

  // Trace : message humain synthétique + placeholder assistant (auteur 'auto-review').
  const userMessage = addForestMessage(repoId, { role: "user", author: "auto-review", body: `🤖 Auto-revue de ${node.ref}`, state: "complete" });
  broadcastForestMessage(repoId, userMessage);
  const pendingMessage = addForestMessage(repoId, { role: "assistant", author: "auto-review", model: mdl, body: "", state: "pending" });
  broadcastForestMessage(repoId, pendingMessage);

  const forestSnapshot = listForest(repoId);
  let forestLinks = [];
  try { forestLinks = listForestLinks(repoId); } catch { /* pas de liens */ }
  let issues = [];
  try { issues = listIssues(repoId, { includeClosed: true, limit: 200 }); } catch { /* pas d'issues */ }
  const history = listForestMessages(repoId, { limit: 1000 }).filter(
    (m) => m.state === "complete" && m.id !== userMessage.id && m.id !== pendingMessage.id
  );

  aiLocks.set(lockKey, { child: null });
  aiInFlight++;
  broadcast(forestKey(repoId), "ai:turn", { repoId, scope: "forest", actor: "auto-review", model: mdl, state: "start", turnId: pendingMessage.id });

  let root = null;
  try { root = rootForRepo(repoId); } catch { /* IA sans accès fichiers */ }

  // Exécute le tour (runForestTurn libère le verrou en finally), puis résout les revues.
  await runForestTurn(repoId, forestSnapshot, history, syntheticText, "auto-review", mdl, pendingMessage.id, root, forestLinks, issues, policyPrompt);

  let affected = [];
  for (const rv of reviews) {
    try {
      // applyActions:false : l'IA a déjà remodelé via applyForestActions ; on ne
      // ré-applique pas les actions suggérées de l'agent. Promotion gérée dedans.
      const r = resolveReview(rv.id, { decision: "approve", applyActions: false, response: `Auto-revue (message #${pendingMessage.id})` }, repoId);
      affected = [...affected, ...(r.affectedNodeIds || [])];
    } catch (e) {
      console.error(`[meowtrack] triggerAutoReview: résolution revue ${rv.id} → ${e.message || e}`);
    }
  }
  if (affected.length) broadcastAffected(repoId, affected);
  broadcast(forestKey(repoId), "review:resolved", { repoId, nodeId, auto: true, messageId: pendingMessage.id });
  return { ok: true, messageId: pendingMessage.id, resolved: reviews.length, autoReviewCount: count };
}

// ── Reprise des tours en file au démarrage (Option B, NODE-329) ──────────────
// Les tours `queued` survivent à un reload mais aucun tour ne tourne pour les
// enchaîner. Au boot on : (1) repasse en erreur les placeholders pending/streaming
// orphelins d'un crash (sinon bulle « en cours » figée), puis (2) (re)déclenche un
// drain par nœud/forêt ayant des éléments en file. Best-effort, borné par le sémaphore
// global : ne jamais casser le démarrage. Renvoie le nombre de tours relancés.
export function resumeQueuedTurns() {
  let resumed = 0;
  let repos = [];
  try { repos = listRepos(); } catch { return 0; }
  for (const r of repos) {
    const repoId = r.id;
    try { failDanglingNodeTurns(repoId); } catch { /* best-effort */ }
    try { failDanglingForestTurns(repoId); } catch { /* best-effort */ }
    try {
      for (const nodeId of listQueuedNodeIds(repoId)) {
        if (aiInFlight >= MAX_CONCURRENT_AI) return resumed;
        drainNodeQueue(repoId, nodeId);
        resumed++;
      }
    } catch (e) { console.error(`[meowtrack] resumeQueuedTurns repo=${repoId} (nœuds): ${e.message || e}`); }
    try {
      if (hasQueuedForestTurn(repoId)) {
        if (aiInFlight >= MAX_CONCURRENT_AI) return resumed;
        drainForestQueue(repoId);
        resumed++;
      }
    } catch (e) { console.error(`[meowtrack] resumeQueuedTurns repo=${repoId} (forêt): ${e.message || e}`); }
  }
  return resumed;
}
