// db/runs.js — orchestrateur : historique d'exécution (node_runs) + points de
// revue (node_reviews) + ingestion fail-closed des rapports .meowtrack/runs/<ref>.json.
//
// Le « run » trace un passage d'agent sur un nœud (réclamé via claimNextNode dans
// ./nodes.js). Le rapport est le canal de feedback : l'agent y dépose un résumé,
// des `nodeUpdates` (modifs du graphe, appliquées via le catalogue sûr) et des
// `reviewPoints` (questions/décisions persistées). Ingestion FAIL-CLOSED : au moindre
// doute → 0 action, rapport conservé tel quel.
//
// Cycle ESM SÛR avec ./nodes.js (findNodeRow / applyNodeActions / markNodeDone /
// requeueNode) : usages en corps de fonction uniquement.

import { db, withRepo, nowIso } from "./connection.js";
import { getOrchestratorConfig } from "./registry.js";
import {
  REVIEW_KIND_SET,
  TEST_RESULT_SET,
  MAX_REVIEW_POINTS,
  MAX_ACTIONS,
} from "./constants.js";
import { findNodeRow, applyNodeActions, markNodeDone, requeueNode } from "./nodes.js";

// Catalogue d'actions DESTRUCTIVES (jamais auto-appliquées depuis un rapport :
// proposées pour confirmation humaine). Aligné sur le pipeline de chat IA.
const DESTRUCTIVE_OPS = new Set(["delete_node", "move_node", "reorder_children"]);

// ── Sérialisation ────────────────────────────────────────────────────────────
function rowToRun(r) {
  if (!r) return null;
  let report = null;
  if (r.report) {
    try {
      report = JSON.parse(r.report);
    } catch {
      report = { raw: String(r.report).slice(0, 4000) };
    }
  }
  return {
    id: r.id,
    nodeId: r.node_id,
    owner: r.owner,
    state: r.state,
    branch: r.branch,
    summary: r.summary,
    error: r.error,
    testResult: r.test_result,
    report,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}
function rowToReview(r) {
  if (!r) return null;
  let suggested = [];
  try {
    suggested = JSON.parse(r.suggested || "[]");
  } catch {
    suggested = [];
  }
  return {
    id: r.id,
    nodeId: r.node_id,
    runId: r.run_id,
    kind: r.kind,
    message: r.message,
    blocking: !!r.blocking,
    suggested: Array.isArray(suggested) ? suggested : [],
    state: r.state,
    response: r.response,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

// ── Historique d'exécution (node_runs) ───────────────────────────────────────
// Démarre un run (état running). Appelé par claimNextNode. Suppose une portée
// withRepo active (ambient `db`).
export function startRun(nodeId, owner, branch = null) {
  const res = db
    .prepare("INSERT INTO node_runs(node_id, owner, state, branch, started_at) VALUES(?,?,?,?,?)")
    .run(nodeId, owner || null, "running", branch || null, nowIso());
  return Number(res.lastInsertRowid);
}

// id du run OUVERT (running) le plus récent d'un nœud pour ce worker (null sinon).
export function currentRunId(nodeId, owner, repoId = null) {
  return withRepo(repoId, () => {
    const r = db
      .prepare("SELECT id FROM node_runs WHERE node_id = ? AND owner IS ? AND state = 'running' ORDER BY id DESC LIMIT 1")
      .get(nodeId, owner || null);
    return r ? r.id : null;
  });
}

// Clôt le run OUVERT d'un nœud (par owner) dans l'état final. Best-effort : si aucun
// run ouvert, en insère un clos (run hors-claim). Suppose une portée withRepo active.
export function finishRun(nodeId, owner, state, { summary, error, branch, testResult, report } = {}) {
  const ts = nowIso();
  const tr = TEST_RESULT_SET.has(testResult) ? testResult : null;
  const reportJson = report != null ? JSON.stringify(report).slice(0, 1_000_000) : null;
  const open = db
    .prepare("SELECT id FROM node_runs WHERE node_id = ? AND owner IS ? AND state = 'running' ORDER BY id DESC LIMIT 1")
    .get(nodeId, owner || null);
  if (open) {
    db.prepare(
      "UPDATE node_runs SET state=?, summary=COALESCE(?,summary), error=COALESCE(?,error), branch=COALESCE(?,branch), test_result=COALESCE(?,test_result), report=COALESCE(?,report), ended_at=? WHERE id=?"
    ).run(state, summary ?? null, error ?? null, branch ?? null, tr, reportJson, ts, open.id);
    return open.id;
  }
  const res = db
    .prepare(
      "INSERT INTO node_runs(node_id, owner, state, branch, summary, error, test_result, report, started_at, ended_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
    )
    .run(nodeId, owner || null, state, branch ?? null, summary ?? null, error ?? null, tr, reportJson, ts, ts);
  return Number(res.lastInsertRowid);
}

export function listRuns(nodeRefOrId, repoId = null) {
  return withRepo(repoId, () => {
    const node = findNodeRow(nodeRefOrId, repoId);
    if (!node) return [];
    return db.prepare("SELECT * FROM node_runs WHERE node_id = ? ORDER BY id DESC").all(node.id).map(rowToRun);
  });
}

// ── Points de revue (node_reviews) ───────────────────────────────────────────
export function addReview(nodeId, { runId = null, kind = "discovery", message, blocking = false, suggested = [] } = {}, repoId = null) {
  return withRepo(repoId, () => {
    const k = REVIEW_KIND_SET.has(kind) ? kind : "discovery";
    const msg = String(message || "").slice(0, 8000);
    if (!msg) throw new Error("Message de revue requis");
    const sug = JSON.stringify((Array.isArray(suggested) ? suggested : []).slice(0, MAX_ACTIONS));
    const res = db
      .prepare("INSERT INTO node_reviews(node_id, run_id, kind, message, blocking, suggested, state, created_at) VALUES(?,?,?,?,?,?, 'open', ?)")
      .run(nodeId, runId, k, msg, blocking ? 1 : 0, sug, nowIso());
    return rowToReview(db.prepare("SELECT * FROM node_reviews WHERE id = ?").get(Number(res.lastInsertRowid)));
  });
}

// Liste les points de revue d'un repo (file globale) ou d'un nœud précis, filtrés
// par état. `ref` omis → tout le repo (jointure sur node pour scoper au repo).
export function listReviews({ ref = null, state = null, repoId = null } = {}) {
  return withRepo(repoId, () => {
    if (ref != null) {
      const node = findNodeRow(ref, repoId);
      if (!node) return [];
      const where = state ? "node_id = ? AND state = ?" : "node_id = ?";
      const args = state ? [node.id, state] : [node.id];
      return db.prepare(`SELECT * FROM node_reviews WHERE ${where} ORDER BY id DESC`).all(...args).map(rowToReview);
    }
    const where = state ? "state = ?" : "1=1";
    const args = state ? [state] : [];
    return db.prepare(`SELECT * FROM node_reviews WHERE ${where} ORDER BY id DESC`).all(...args).map(rowToReview);
  });
}

export function getReview(reviewId, repoId = null) {
  return withRepo(repoId, () => rowToReview(db.prepare("SELECT * FROM node_reviews WHERE id = ?").get(reviewId)));
}

// Reste-t-il un point de revue OUVERT et BLOQUANT sur ce nœud ?
export function hasOpenBlockingReview(nodeId, repoId = null) {
  return withRepo(repoId, () => {
    const r = db.prepare("SELECT COUNT(*) c FROM node_reviews WHERE node_id = ? AND state = 'open' AND blocking = 1").get(nodeId);
    return r.c > 0;
  });
}

// Sépare les actions destructives (jamais auto-appliquées) du reste.
function splitDestructive(actions) {
  const list = Array.isArray(actions) ? actions.slice(0, MAX_ACTIONS) : [];
  const safe = [];
  const destructive = [];
  for (const a of list) (a && DESTRUCTIVE_OPS.has(a.op) ? destructive : safe).push(a);
  return { safe, destructive };
}

// ── Ingestion d'un rapport (fail-closed) ─────────────────────────────────────
// `report` = objet déjà parsé depuis .meowtrack/runs/<ref>.json (ou inline). Persiste
// les reviewPoints en node_reviews ; applique les nodeUpdates NON destructifs via
// applyNodeActions (scope sous-arbre) SI run.autoApplyUpdates ; les actions
// destructives (ou tout, si autoApply off) sont PROPOSÉES (review 'decision' avec
// suggested) pour confirmation. Renvoie { hasBlockingReview, applied, reviews, proposed }.
export function ingestRunReport(nodeId, runId, report, repoId = null) {
  return withRepo(repoId, () => {
    const out = { hasBlockingReview: false, applied: [], rejected: [], reviews: [], proposed: 0 };
    if (!report || typeof report !== "object" || Array.isArray(report)) return out; // fail-closed
    const cfg = getOrchestratorConfig(repoId);

    // 1. nodeUpdates → application sûre (non destructif + autoApply) sinon proposition.
    const updates = Array.isArray(report.nodeUpdates) ? report.nodeUpdates : [];
    if (updates.length) {
      const { safe, destructive } = splitDestructive(updates);
      if (cfg.autoApplyUpdates && safe.length) {
        const r = applyNodeActions(nodeId, safe, repoId);
        out.applied = r.applied;
        out.rejected = r.rejected;
      }
      const toPropose = cfg.autoApplyUpdates ? destructive : [...safe, ...destructive];
      if (toPropose.length) {
        const rev = addReview(
          nodeId,
          {
            runId,
            kind: "decision",
            message: `L'agent propose ${toPropose.length} modification(s) du graphe à confirmer.`,
            blocking: false,
            suggested: toPropose,
          },
          repoId
        );
        out.reviews.push(rev);
        out.proposed = toPropose.length;
      }
    }

    // 2. reviewPoints → persistés (un bloquant met le nœud en revue côté completeNode).
    const points = Array.isArray(report.reviewPoints) ? report.reviewPoints.slice(0, MAX_REVIEW_POINTS) : [];
    for (const p of points) {
      if (!p || typeof p !== "object") continue;
      const msg = String(p.message || "").trim();
      if (!msg) continue;
      try {
        const rev = addReview(
          nodeId,
          {
            runId,
            kind: p.kind,
            message: msg,
            blocking: !!p.blocking,
            suggested: Array.isArray(p.suggestedActions) ? p.suggestedActions : [],
          },
          repoId
        );
        out.reviews.push(rev);
        if (rev.blocking) out.hasBlockingReview = true;
      } catch (e) {
        console.error(`[meowtrack] ingestRunReport: point ignoré → ${e.message || e}`);
      }
    }
    return out;
  });
}

// ── Résolution d'un point de revue (humain) ──────────────────────────────────
// decision: 'approve' (applique suggested si applyActions) | 'dismiss' (rejette) |
// 'rework' (remet le nœud actif → reréclamable). Après résolution, si plus aucun
// point bloquant ne reste ET le nœud est en revue, on le promeut review→done.
export function resolveReview(reviewId, { decision = "approve", applyActions = true, response = null } = {}, repoId = null) {
  return withRepo(repoId, () => {
    const review = rowToReview(db.prepare("SELECT * FROM node_reviews WHERE id = ?").get(reviewId));
    if (!review) throw new Error("Point de revue introuvable");
    if (review.state !== "open") return { ok: true, review, alreadyResolved: true };
    const ts = nowIso();
    let applied = [];
    let affectedNodeIds = [];

    if (decision === "approve") {
      if (applyActions && review.suggested.length) {
        const r = applyNodeActions(review.nodeId, review.suggested, repoId);
        applied = r.applied;
        affectedNodeIds = r.affectedNodeIds;
      }
      db.prepare("UPDATE node_reviews SET state='resolved', response=?, resolved_at=? WHERE id=?").run(response, ts, reviewId);
    } else if (decision === "rework") {
      db.prepare("UPDATE node_reviews SET state='resolved', response=?, resolved_at=? WHERE id=?").run(response, ts, reviewId);
      requeueNode(review.nodeId, repoId); // → run_state NULL, status active : reréclamable
    } else {
      db.prepare("UPDATE node_reviews SET state='dismissed', response=?, resolved_at=? WHERE id=?").run(response, ts, reviewId);
    }

    // Promotion review→done si plus aucun point bloquant et nœud en attente de revue.
    let promoted = false;
    const node = findNodeRow(review.nodeId, repoId);
    if (node && node.run_state === "review" && !hasOpenBlockingReview(review.nodeId, repoId)) {
      const aff = markNodeDone(review.nodeId, repoId);
      affectedNodeIds = [...new Set([...affectedNodeIds, ...aff])];
      promoted = true;
    }
    return { ok: true, review: rowToReview(db.prepare("SELECT * FROM node_reviews WHERE id = ?").get(reviewId)), applied, affectedNodeIds, promoted };
  });
}
