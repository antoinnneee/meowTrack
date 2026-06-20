// db/issues.js — domaine ISSUES : entrées (bug/feature/task/chore), références de
// chemins (validées contre le dépôt cloné via repos.js) et commentaires.
//
// Toutes les fonctions publiques ouvrent une portée withRepo(repoId, …) puis
// opèrent sur le tracker COURANT via le proxy `db`. Les helpers internes (findRow,
// touchIssue, setReferences…) supposent une portée déjà ouverte par l'appelant.

import { db, withRepo, nowIso, nextRef } from "./connection.js";
import { TYPES, STATUSES, PRIORITIES } from "./constants.js";
import { inspectPathFor, gitContextFor, branchContextFor, normalizePathFor } from "../repos.js";

// Extrait les tokens `@chemin` d'un texte (description). Accepte lettres, chiffres,
// `_ . / -`. Renvoie la liste dédupliquée (ordre d'apparition).
export function extractMentions(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const re = /@([A-Za-z0-9_./-]+(?::\d+(?:-\d+)?)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

// Décompose un token de référence `path` ou `path:120` ou `path:120-145`.
function parseRefSpec(spec) {
  if (typeof spec === "object" && spec) {
    return {
      path: spec.path,
      lineStart: spec.lineStart ?? spec.line_start ?? null,
      lineEnd: spec.lineEnd ?? spec.line_end ?? null,
    };
  }
  const s = String(spec);
  const mm = s.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (mm) return { path: mm[1], lineStart: Number(mm[2]), lineEnd: mm[3] ? Number(mm[3]) : null };
  return { path: s, lineStart: null, lineEnd: null };
}

function sanitizeTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(",");
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))];
}

// ── Sérialisation ────────────────────────────────────────────────────────────
function rowToIssue(row, { withDetail = false } = {}) {
  if (!row) return null;
  const issue = {
    id: row.id,
    repoId: row.repo_id,
    ref: row.ref,
    type: row.type,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    tags: JSON.parse(row.tags || "[]"),
    branch: row.branch,
    commit: row.git_commit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    references: listReferences(row.id),
  };
  if (withDetail) issue.comments = listComments(row.id);
  return issue;
}

// ── Références ───────────────────────────────────────────────────────────────
// repoId = dépôt propriétaire de l'issue (sélectionne la base tracker). Omis quand
// l'appel est déjà dans une portée withRepo (sous-appel de rowToIssue → hérite).
export function listReferences(issueId, repoId = null) {
  return withRepo(repoId, () =>
    db
      .prepare("SELECT * FROM refs WHERE issue_id = ? ORDER BY id")
      .all(issueId)
      .map((r) => ({
        id: r.id,
        path: r.path,
        kind: r.kind,
        lineStart: r.line_start,
        lineEnd: r.line_end,
        existed: !!r.existed,
      }))
  );
}

export function addReference(issueId, spec, repoId = null) {
  return withRepo(repoId, () => {
    // Repo + branche de l'issue : la validation des chemins se fait dans CE repo,
    // dans l'arbre de la branche de l'issue (pas le working tree courant).
    const issueRow = db.prepare("SELECT repo_id, branch FROM issues WHERE id = ?").get(issueId);
    if (!issueRow) throw new Error(`Issue introuvable : ${issueId}`);
    const { repo_id: rid, branch } = issueRow;
    const { path, lineStart, lineEnd } = parseRefSpec(spec);
    const norm = normalizePathFor(rid, path);
    if (!norm) throw new Error(`Chemin invalide ou hors repo : ${path}`);
    const info = inspectPathFor(rid, norm, branch);
    const info2 = db
      .prepare("INSERT INTO refs(issue_id, path, kind, line_start, line_end, existed) VALUES(?,?,?,?,?,?)")
      .run(issueId, norm, info.kind, lineStart, lineEnd, info.exists ? 1 : 0);
    touchIssue(issueId);
    return db.prepare("SELECT * FROM refs WHERE id = ?").get(info2.lastInsertRowid);
  });
}

export function removeReference(refId, repoId = null) {
  return withRepo(repoId, () => {
    const row = db.prepare("SELECT issue_id FROM refs WHERE id = ?").get(refId);
    const res = db.prepare("DELETE FROM refs WHERE id = ?").run(refId);
    if (row) touchIssue(row.issue_id);
    return res.changes > 0;
  });
}

// Remplace l'intégralité des références d'une issue par `specs` (dédupliqué).
// Validées dans `repoId`, dans l'arbre de `branch`.
function setReferences(issueId, repoId, specs, branch = null) {
  db.prepare("DELETE FROM refs WHERE issue_id = ?").run(issueId);
  const seen = new Set();
  for (const spec of specs || []) {
    const { path, lineStart, lineEnd } = parseRefSpec(spec);
    const norm = normalizePathFor(repoId, path);
    if (!norm) continue;
    const key = `${norm}:${lineStart ?? ""}:${lineEnd ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const info = inspectPathFor(repoId, norm, branch);
    db.prepare(
      "INSERT INTO refs(issue_id, path, kind, line_start, line_end, existed) VALUES(?,?,?,?,?,?)"
    ).run(issueId, norm, info.kind, lineStart, lineEnd, info.exists ? 1 : 0);
  }
}

// ── Commentaires ─────────────────────────────────────────────────────────────
export function listComments(issueId, repoId = null) {
  return withRepo(repoId, () =>
    db.prepare("SELECT id, body, created_at AS createdAt FROM comments WHERE issue_id = ? ORDER BY id").all(issueId)
  );
}

export function addComment(repoId, refOrId, body) {
  return withRepo(repoId, () => {
    const issue = findRow(repoId, refOrId);
    if (!issue) throw new Error(`Issue introuvable : ${refOrId}`);
    if (!body || !String(body).trim()) throw new Error("Commentaire vide");
    db.prepare("INSERT INTO comments(issue_id, body) VALUES(?, ?)").run(issue.id, String(body).trim());
    touchIssue(issue.id);
    return getIssueById(issue.id);
  });
}

// ── Issues ───────────────────────────────────────────────────────────────────
// Résout une issue par id numérique (repo ignoré, id global) ou par code (exige
// repoId — les codes sont uniques PAR repo). `repoId` peut être null pour un id.
function findRow(repoId, refOrId) {
  if (refOrId == null) return null;
  if (typeof refOrId === "number" || /^\d+$/.test(String(refOrId))) {
    return db.prepare("SELECT * FROM issues WHERE id = ?").get(Number(refOrId));
  }
  if (repoId == null) throw new Error("repo requis pour résoudre un code d'issue");
  return db.prepare("SELECT * FROM issues WHERE repo_id = ? AND ref = ? COLLATE NOCASE").get(repoId, String(refOrId));
}
function getIssueById(id) {
  return rowToIssue(db.prepare("SELECT * FROM issues WHERE id = ?").get(id), { withDetail: true });
}

function touchIssue(id) {
  db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(nowIso(), id);
}

export function getIssue(repoId, refOrId) {
  return withRepo(repoId, () => rowToIssue(findRow(repoId, refOrId), { withDetail: true }));
}

export function createIssue(repoId, input = {}) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
  const type = TYPES.includes(input.type) ? input.type : "bug";
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Titre requis");
  const status = STATUSES.includes(input.status) ? input.status : "open";
  const priority = PRIORITIES.includes(input.priority) ? input.priority : "medium";
  const description = String(input.description || "");
  const tags = JSON.stringify(sanitizeTags(input.tags));
  // Branche choisie explicitement (tracking + validation des chemins) sinon HEAD du repo.
  const ctx = input.branch ? branchContextFor(repoId, String(input.branch)) : gitContextFor(repoId);

  const specs = [...(input.paths || input.references || [])];
  if (input.autoMention !== false) specs.push(...extractMentions(description));

  const ref = nextRef(repoId, type);
  const tx = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO issues(repo_id, ref, type, title, description, status, priority, tags, branch, git_commit)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(repoId, ref, type, title, description, status, priority, tags, ctx.branch, ctx.commit);
    const id = res.lastInsertRowid;
    setReferences(id, repoId, specs, ctx.branch);
    return id;
  });
  return getIssueById(tx());
  });
}

export function updateIssue(repoId, refOrId, fields = {}) {
  return withRepo(repoId, () => {
  const row = findRow(repoId, refOrId);
  if (!row) throw new Error(`Issue introuvable : ${refOrId}`);
  const sets = [];
  const vals = [];
  const set = (col, v) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (fields.title != null) {
    const t = String(fields.title).trim();
    if (t) set("title", t);
  }
  if (fields.description != null) set("description", String(fields.description));
  if (fields.type != null && TYPES.includes(fields.type)) set("type", fields.type);
  if (fields.status != null) {
    if (!STATUSES.includes(fields.status)) throw new Error(`Statut invalide : ${fields.status}`);
    set("status", fields.status);
  }
  if (fields.priority != null) {
    if (!PRIORITIES.includes(fields.priority)) throw new Error(`Priorité invalide : ${fields.priority}`);
    set("priority", fields.priority);
  }
  if (fields.tags != null) set("tags", JSON.stringify(sanitizeTags(fields.tags)));
  // Changement de branche : recapture aussi le commit du sommet de cette branche.
  let newBranch = row.branch;
  if (fields.branch != null) {
    const ctx = branchContextFor(row.repo_id, String(fields.branch) || null);
    newBranch = ctx.branch;
    set("branch", ctx.branch);
    set("git_commit", ctx.commit);
  }

  const tx = db.transaction(() => {
    if (sets.length) {
      set("updated_at", nowIso());
      db.prepare(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`).run(...vals, row.id);
    }
    if (fields.paths != null || fields.references != null) {
      setReferences(row.id, row.repo_id, fields.paths || fields.references || [], newBranch);
      touchIssue(row.id);
    }
  });
  tx();
  return getIssueById(row.id);
  });
}

export function deleteIssue(repoId, refOrId) {
  return withRepo(repoId, () => {
    const row = findRow(repoId, refOrId);
    if (!row) return false;
    db.prepare("DELETE FROM issues WHERE id = ?").run(row.id); // cascade refs + comments
    return true;
  });
}

export function listIssues(repoId, filter = {}) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
  const where = ["repo_id = ?"];
  const vals = [repoId];
  if (filter.type) {
    where.push("type = ?");
    vals.push(filter.type);
  }
  if (filter.status) {
    where.push("status = ?");
    vals.push(filter.status);
  } else if (filter.open !== undefined ? filter.open : filter.includeClosed !== true) {
    if (filter.includeClosed !== true && !filter.status) where.push("status IN ('open','in_progress')");
  }
  if (filter.priority) {
    where.push("priority = ?");
    vals.push(filter.priority);
  }
  if (filter.branch) {
    where.push("branch = ?");
    vals.push(filter.branch);
  }
  if (filter.tag) {
    where.push("tags LIKE ?");
    vals.push(`%"${filter.tag}"%`);
  }
  if (filter.path) {
    where.push("id IN (SELECT issue_id FROM refs WHERE path LIKE ?)");
    vals.push(`%${filter.path}%`);
  }
  if (filter.text) {
    where.push("(title LIKE ? OR description LIKE ? OR ref LIKE ?)");
    const like = `%${filter.text}%`;
    vals.push(like, like, like);
  }
  const sql =
    "SELECT * FROM issues WHERE " +
    where.join(" AND ") +
    " ORDER BY " +
    "CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'wontfix' THEN 2 WHEN 'done' THEN 3 END, " +
    "CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, " +
    "updated_at DESC";
  const rows = db.prepare(sql).all(...vals);
  const limit = filter.limit ? Math.max(1, Math.min(500, filter.limit)) : 200;
  return rows.slice(0, limit).map((r) => rowToIssue(r));
  });
}

// Statistiques pour le dashboard / tool de résumé, scopées par repo.
export function stats(repoId) {
  if (repoId == null) throw new Error("repoId requis");
  return withRepo(repoId, () => {
  const byStatus = {};
  for (const r of db.prepare("SELECT status, COUNT(*) c FROM issues WHERE repo_id = ? GROUP BY status").all(repoId)) byStatus[r.status] = r.c;
  const byType = {};
  for (const r of db.prepare("SELECT type, COUNT(*) c FROM issues WHERE repo_id = ? GROUP BY type").all(repoId)) byType[r.type] = r.c;
  const byPriority = {};
  for (const r of db.prepare("SELECT priority, COUNT(*) c FROM issues WHERE repo_id = ? GROUP BY priority").all(repoId))
    byPriority[r.priority] = r.c;
  const total = db.prepare("SELECT COUNT(*) c FROM issues WHERE repo_id = ?").get(repoId).c;
  return { total, byStatus, byType, byPriority };
  });
}
