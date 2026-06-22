// routes/nodes.js — Vibes v2 : arbre de nœuds (CRUD + positions + sous-arbre),
// chat « top level » (forêt) et flux SSE temps réel. L'ordre des routes est
// SIGNIFIANT : /stream et /positions passent AVANT les routes paramétrées /:ref.

import { send, readBody, repoOf } from "../http-util.js";
import {
  listForestMessages,
  clearForestMessages,
  deleteForestMessage,
  listForest,
  listRootNodes,
  createNode,
  setNodePositions,
  getNode,
  updateNode,
  deleteNode,
  moveNode,
  reorderChildren,
  listNodeMessages,
  clearNodeMessages,
  deleteNodeMessage,
  listForestLinks,
  addNodeLink,
  removeNodeLink,
  claimNextNode,
  renewLease,
  completeNode,
  failNode,
  currentRunId,
  listRuns,
  ingestRunReport,
  listReviews,
  getReview,
  resolveReview,
  getOrchestratorConfig,
} from "../db.js";
import { readRunReport } from "../repos.js";
import { openStream, forestKey, nodeKey, broadcast, broadcastAffected, refreshAncestors } from "../sse.js";
import {
  handleForestChat,
  handleForestChatConfirm,
  handleNodeChat,
  handleNodeChatConfirm,
  triggerAutoReview,
  nodeAiBusy,
  forestAiBusy,
} from "../ai/turns.js";

export async function handle(ctx) {
  const { req, res, method, path, q } = ctx;

  // SSE forêt (canal `forest:<repoId>`). Avant les routes paramétrées.
  if (method === "GET" && path === "/api/nodes/stream") {
    openStream(req, res, forestKey(repoOf(q)));
    return true;
  }

  // ── Chat « top level » (forêt d'un repo) — réutilise le SSE forêt ──────────
  // GET /api/forest/messages?repo= — historique du chat de forêt.
  if (method === "GET" && path === "/api/forest/messages") {
    send(res, 200, listForestMessages(repoOf(q), { afterId: Number(q.get("afterId")) || 0, limit: Number(q.get("limit")) || 500 }));
    return true;
  }
  // DELETE /api/forest/messages?repo= — vide l'historique (refusé pendant un tour IA).
  if (method === "DELETE" && path === "/api/forest/messages") {
    const id = repoOf(q);
    if (forestAiBusy(id)) return send(res, 409, { error: "ai_busy" }), true;
    const removed = clearForestMessages(id);
    broadcast(forestKey(id), "chat:cleared", { repoId: id, scope: "forest" });
    send(res, 200, { ok: true, removed });
    return true;
  }
  // DELETE /api/forest/messages/:id?repo= — retire un message (refusé pendant un tour IA).
  const fmDel = path.match(/^\/api\/forest\/messages\/(\d+)$/);
  if (method === "DELETE" && fmDel) {
    const id = repoOf(q);
    if (forestAiBusy(id)) return send(res, 409, { error: "ai_busy" }), true;
    const removed = deleteForestMessage(Number(fmDel[1]), id);
    if (removed) broadcast(forestKey(id), "message:deleted", { id: Number(fmDel[1]), scope: "forest" });
    send(res, removed ? 200 : 404, removed ? { ok: true, removed } : { error: "introuvable" });
    return true;
  }
  // POST /api/forest/chat?repo= — un message → tour IA streaming (objectifs racines…).
  if (method === "POST" && path === "/api/forest/chat") {
    const body = await readBody(req);
    handleForestChat(res, repoOf(q, body), body);
    return true;
  }
  // POST /api/forest/chat/confirm?repo= { messageId } — confirme une action destructive.
  if (method === "POST" && path === "/api/forest/chat/confirm") {
    const body = await readBody(req);
    handleForestChatConfirm(req, res, repoOf(q, body), body);
    return true;
  }
  // GET /api/nodes?repo= — racines (grille) ou ?view=forest (graphe = tout l'arbre).
  if (method === "GET" && path === "/api/nodes") {
    const id = repoOf(q);
    if (q.get("view") === "forest") {
      const includeNotes = q.get("includeNotes") !== "false";
      return send(res, 200, listForest(id, { includeNotes })), true;
    }
    send(
      res,
      200,
      listRootNodes(id, { status: q.get("status") || undefined, text: q.get("text") || undefined, limit: Number(q.get("limit")) || undefined })
    );
    return true;
  }
  // POST /api/nodes?repo= — créer un nœud (racine ou enfant via parentId).
  if (method === "POST" && path === "/api/nodes") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    const parentId = body.parentId != null ? body.parentId : null;
    console.error(
      `[meowtrack] POST /api/nodes repo=${id ?? "(défaut)"} parentId=${parentId ?? "(racine)"} title=${JSON.stringify(String(body.title || "").slice(0, 60))}`
    );
    const n = createNode(id, parentId, body);
    console.error(`[meowtrack]   → nœud créé NODE-${n.ref} (id=${n.id}, repo=${n.repoId}, parent=${n.parentId ?? "(racine)"})`);
    broadcast(forestKey(n.repoId), "node:created", n);
    if (n.parentId != null) {
      broadcast(nodeKey(n.repoId, n.parentId), "node:created", n);
      refreshAncestors(n.repoId, n.parentId, n.id); // progression + dirty des ancêtres
    }
    send(res, 201, n);
    return true;
  }

  // POST /api/nodes/positions?repo= — persiste les positions manuelles (drag).
  // Avant la route paramétrée (sinon « positions » serait pris pour un :ref).
  if (method === "POST" && path === "/api/nodes/positions") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    const list = Array.isArray(body.positions) ? body.positions : [];
    setNodePositions(list, id);
    // Notifie la forêt du repo (les autres clients re-positionnent en douceur).
    broadcast(forestKey(id), "nodes:moved", { positions: list });
    send(res, 200, { ok: true, count: list.length });
    return true;
  }

  // ── Liens de prérequis (graphe additif). AVANT la route paramétrée (sinon
  // « links » serait pris pour un :ref). Diffuse links:changed sur la forêt +
  // les rooms des deux nœuds pour que toutes les vues se re-synchronisent.
  if (path === "/api/nodes/links") {
    const id = repoOf(q);
    if (method === "GET") {
      send(res, 200, listForestLinks(id));
      return true;
    }
    const body = await readBody(req);
    const rid = repoOf(q, body);
    const ping = (r) => {
      const payload = { fromId: r.fromId, toId: r.toId, repoId: r.repoId };
      broadcast(forestKey(rid), "links:changed", payload);
      if (r.fromId != null) broadcast(nodeKey(rid, r.fromId), "links:changed", payload);
      if (r.toId != null) broadcast(nodeKey(rid, r.toId), "links:changed", payload);
    };
    if (method === "POST") {
      try {
        const r = addNodeLink(body.fromId, body.toId, { repoId: rid });
        ping(r);
        send(res, 201, r);
      } catch (e) {
        send(res, 400, { error: "link_failed", message: e.message });
      }
      return true;
    }
    if (method === "DELETE") {
      const r = removeNodeLink(body.fromId, body.toId, { repoId: rid });
      if (r.removed) ping(r);
      send(res, 200, r);
      return true;
    }
  }

  // ── Orchestrateur : file de travail (collection). AVANT la route paramétrée. ──
  // POST /api/nodes/next { owner } — réclame atomiquement la prochaine tâche prête.
  if (method === "POST" && path === "/api/nodes/next") {
    const body = await readBody(req);
    const id = repoOf(q, body);
    const owner = String(body.owner || "").trim();
    if (!owner) return send(res, 400, { error: "owner_requis" }), true;
    const cfg = getOrchestratorConfig(id);
    const node = claimNextNode(id, owner, { leaseMs: cfg.leaseMs, maxAttempts: cfg.maxAttempts, branch: body.branch || null });
    if (node) {
      broadcast(forestKey(node.repoId), "node:updated", node);
      broadcast(nodeKey(node.repoId, node.id), "node:updated", node);
    }
    send(res, 200, { node: node || null, config: { leaseMs: cfg.leaseMs, branchPrefix: cfg.branchPrefix, testCommand: cfg.testCommand } });
    return true;
  }
  // GET /api/nodes/reviews?state= — file globale des points de revue d'un repo.
  if (method === "GET" && path === "/api/nodes/reviews") {
    const id = repoOf(q);
    send(res, 200, listReviews({ state: q.get("state") || null, repoId: id }));
    return true;
  }

  // /api/nodes/:ref[…] (résolution du code scopée par ?repo=)
  const nodeMatch = path.match(/^\/api\/nodes\/([^/]+)(\/subtree|\/messages(?:\/\d+)?|\/move|\/reorder|\/chat(?:\/confirm)?|\/stream)?$/);
  if (nodeMatch) {
    const ref = decodeURIComponent(nodeMatch[1]);
    const sub = nodeMatch[2] || "";
    const id = repoOf(q);
    const node = getNode(ref, { repoId: id });

    if (sub === "/stream") {
      if (!node) return send(res, 404, { error: "not_found", ref }), true;
      openStream(req, res, nodeKey(id, node.id));
      return true;
    }
    if (sub === "" && method === "GET") {
      send(
        res,
        node ? 200 : 404,
        node ? getNode(node.id, { repoId: id, withTree: q.get("tree") !== "false", withMessages: q.get("messages") === "true", withLinks: true, withIssues: true }) : { error: "not_found", ref }
      );
      return true;
    }
    if (!node) return send(res, 404, { error: "not_found", ref }), true;

    if (sub === "/subtree" && method === "GET") {
      send(res, 200, getNode(node.id, { repoId: id, withTree: true }));
      return true;
    }
    if (sub === "" && method === "PATCH") {
      const body = await readBody(req);
      try {
        const n = updateNode(node.id, body, body.expectedVersion, id);
        refreshAncestors(id, n.id, n.id); // n + ancêtres (progression) + dirty
        send(res, 200, n);
        return true;
      } catch (e) {
        if (e.code === "version_conflict") return send(res, 409, { error: "version_conflict", node: e.node }), true;
        throw e;
      }
    }
    if (sub === "" && method === "DELETE") {
      const repoId = node.repoId;
      const r = deleteNode(node.id, repoId);
      const payload = { id: node.id, parentId: r.parentId, rootId: r.rootId };
      broadcast(nodeKey(repoId, node.id), "node:deleted", payload);
      broadcast(forestKey(repoId), "node:deleted", payload);
      if (r.parentId != null) {
        broadcast(nodeKey(repoId, r.parentId), "node:deleted", payload);
        refreshAncestors(repoId, r.parentId, node.id); // progression des ancêtres + dirty
      }
      send(res, 200, r);
      return true;
    }
    if (sub === "/move" && method === "POST") {
      const { newParentId, position } = await readBody(req);
      const oldParentId = node.parentId;
      const n = moveNode(node.id, newParentId != null ? newParentId : null, position, id);
      broadcast(forestKey(n.repoId), "node:reparented", { id: n.id, parentId: n.parentId, rootId: n.rootId });
      refreshAncestors(n.repoId, n.id, n.id);
      if (oldParentId != null && oldParentId !== n.parentId) refreshAncestors(n.repoId, oldParentId, n.id);
      send(res, 200, n);
      return true;
    }
    if (sub === "/reorder" && method === "POST") {
      const { order } = await readBody(req);
      reorderChildren(node.id, order || [], id);
      refreshAncestors(id, node.id, node.id);
      broadcast(forestKey(node.repoId), "nodes:reordered", { parentId: node.id });
      send(res, 200, getNode(node.id, { repoId: id, withTree: true }));
      return true;
    }
    if (sub === "/messages" && method === "GET") {
      send(res, 200, listNodeMessages(node.id, { afterId: Number(q.get("afterId")) || 0, limit: Number(q.get("limit")) || 500, repoId: id }));
      return true;
    }
    if (sub === "/messages" && method === "DELETE") {
      if (nodeAiBusy(node.id)) return send(res, 409, { error: "ai_busy" }), true; // pas pendant un tour IA
      const removed = clearNodeMessages(node.id, id);
      broadcast(nodeKey(id, node.id), "chat:cleared", { nodeId: node.id });
      send(res, 200, { ok: true, removed });
      return true;
    }
    // DELETE /api/nodes/:ref/messages/:id — retire un message (refusé pendant un tour IA).
    const msgDel = method === "DELETE" && sub.match(/^\/messages\/(\d+)$/);
    if (msgDel) {
      if (nodeAiBusy(node.id)) return send(res, 409, { error: "ai_busy" }), true;
      const removed = deleteNodeMessage(Number(msgDel[1]), node.id, id);
      if (removed) broadcast(nodeKey(id, node.id), "message:deleted", { id: Number(msgDel[1]), nodeId: node.id });
      send(res, removed ? 200 : 404, removed ? { ok: true, removed } : { error: "introuvable" });
      return true;
    }
    if (sub === "/chat" && method === "POST") {
      await handleNodeChat(req, res, node);
      return true;
    }
    if (sub === "/chat/confirm" && method === "POST") {
      handleNodeChatConfirm(req, res, node, await readBody(req));
      return true;
    }
  }

  // ── Orchestrateur : endpoints PAR nœud (hors regex paramétré ci-dessus) ──────
  const orch = path.match(/^\/api\/nodes\/([^/]+)\/(complete|fail|heartbeat|runs|reviews|reviews\/auto|reviews\/(\d+)\/resolve)$/);
  if (orch) {
    const ref = decodeURIComponent(orch[1]);
    const action = orch[2];
    const id = repoOf(q);
    const node = getNode(ref, { repoId: id });
    if (!node) return send(res, 404, { error: "not_found", ref }), true;
    const repoId = node.repoId;

    // GET …/runs — historique d'exécution du nœud.
    if (action === "runs" && method === "GET") {
      send(res, 200, listRuns(node.id, id));
      return true;
    }
    // GET …/reviews — points de revue du nœud.
    if (action === "reviews" && method === "GET") {
      send(res, 200, listReviews({ ref: node.id, state: q.get("state") || null, repoId: id }));
      return true;
    }
    // POST …/heartbeat { owner } — prolonge le bail.
    if (action === "heartbeat" && method === "POST") {
      const body = await readBody(req);
      const owner = String(body.owner || "").trim();
      const cfg = getOrchestratorConfig(id);
      const ok = renewLease(node.id, owner, cfg.leaseMs, id);
      send(res, ok ? 200 : 409, ok ? { ok: true } : { error: "lease_lost" });
      return true;
    }
    // POST …/fail { owner, error, branch? } — échec borné.
    if (action === "fail" && method === "POST") {
      const body = await readBody(req);
      const owner = String(body.owner || "").trim();
      if (!owner) return send(res, 400, { error: "owner_requis" }), true;
      const r = failNode(node.id, owner, { error: body.error, branch: body.branch }, id);
      broadcast(forestKey(repoId), "node:updated", getNode(node.id, { repoId: id }));
      send(res, 200, r);
      return true;
    }
    // POST …/complete { owner, summary?, branch?, testResult?, report? } — clôt → ingère → débloque|revue.
    if (action === "complete" && method === "POST") {
      const body = await readBody(req);
      const owner = String(body.owner || "").trim();
      if (!owner) return send(res, 400, { error: "owner_requis" }), true;
      // Rapport : inline (body.report) sinon lu depuis .meowtrack/runs/<ref>.json du clone.
      let report = body.report && typeof body.report === "object" && !Array.isArray(body.report) ? body.report : null;
      if (!report) {
        const rr = readRunReport(repoId, node.ref);
        if (rr.found && rr.report) report = rr.report;
      }
      const runId = currentRunId(node.id, owner, id);
      const ingest = report ? ingestRunReport(node.id, runId, report, id) : { hasBlockingReview: false, reviews: [], applied: [] };
      let r;
      try {
        r = completeNode(
          node.id,
          owner,
          { summary: body.summary, branch: body.branch, testResult: body.testResult, report, hasBlockingReview: ingest.hasBlockingReview },
          id
        );
      } catch (e) {
        if (e.code === "lease_lost") return send(res, 409, { error: "lease_lost" }), true;
        throw e;
      }
      broadcastAffected(repoId, r.affectedNodeIds);
      if (ingest.issuesChanged) broadcast(forestKey(repoId), "issues:changed", { repoId });
      const openReviews = ingest.reviews.filter((rv) => rv.state === "open");
      if (openReviews.length) broadcast(forestKey(repoId), "review:open", { repoId, nodeId: node.id, count: openReviews.length });
      // Déclenchement AUTOMATIQUE de l'auto-revue si activé et point bloquant (tâche de fond).
      const cfg = getOrchestratorConfig(id);
      if (cfg.autoReview && ingest.hasBlockingReview) {
        const blockingIds = ingest.reviews.filter((rv) => rv.blocking && rv.state === "open").map((rv) => rv.id);
        triggerAutoReview(repoId, node.id, blockingIds, { model: cfg.autoReviewModel, policyPrompt: cfg.autoReviewPrompt }).catch(() => {});
      }
      send(res, 200, { ok: true, state: r.state, affected: r.affectedNodeIds, reviews: ingest.reviews });
      return true;
    }
    // POST …/reviews/auto { reviewIds?, model? } — auto-revue par le chat IA top-level.
    if (action === "reviews/auto" && method === "POST") {
      const body = await readBody(req);
      if (forestAiBusy(repoId)) return send(res, 409, { error: "ai_busy" }), true;
      const cfg = getOrchestratorConfig(id);
      const reviewIds = Array.isArray(body.reviewIds) ? body.reviewIds.map(Number).filter(Number.isFinite) : null;
      // Fire-and-forget : on répond 202 immédiatement, le tour streame via SSE
      // (forest:<repoId>) puis résout les points de revue (cf. triggerAutoReview).
      triggerAutoReview(repoId, node.id, reviewIds, {
        model: body.model || cfg.autoReviewModel,
        policyPrompt: cfg.autoReviewPrompt,
      }).catch(() => {});
      send(res, 202, { ok: true, started: true });
      return true;
    }
    // POST …/reviews/:id/resolve { decision?, applyActions?, response? } — résolution humaine.
    if (orch[3] && method === "POST") {
      const body = await readBody(req);
      const reviewId = Number(orch[3]);
      const review = getReview(reviewId, id);
      if (!review || review.nodeId !== node.id) return send(res, 404, { error: "not_found" }), true;
      const r = resolveReview(reviewId, { decision: body.decision, applyActions: body.applyActions !== false, response: body.response }, id);
      broadcastAffected(repoId, r.affectedNodeIds || []);
      if (r.issuesChanged) broadcast(forestKey(repoId), "issues:changed", { repoId });
      broadcast(forestKey(repoId), "review:resolved", { repoId, nodeId: node.id, reviewId, promoted: !!r.promoted });
      send(res, 200, r);
      return true;
    }
  }

  return false;
}
