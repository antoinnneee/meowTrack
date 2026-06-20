// routes/issues.js — entrées de suivi (issues), commentaires et références de chemins.

import { send, readBody, repoOf } from "../http-util.js";
import { listIssues, createIssue, getIssue, updateIssue, deleteIssue, addComment, addReference, removeReference } from "../db.js";

export async function handle(ctx) {
  const { req, res, method, path, q } = ctx;

  // GET /api/issues?repo= — liste filtrée (scopée repo).
  if (method === "GET" && path === "/api/issues") {
    const id = repoOf(q);
    const filter = {
      type: q.get("type") || undefined,
      status: q.get("status") || undefined,
      priority: q.get("priority") || undefined,
      branch: q.get("branch") || undefined,
      tag: q.get("tag") || undefined,
      path: q.get("path") || undefined,
      text: q.get("text") || undefined,
      includeClosed: q.get("includeClosed") === "true",
      limit: Number(q.get("limit")) || undefined,
    };
    send(res, 200, listIssues(id, filter));
    return true;
  }
  // POST /api/issues?repo= — créer dans le repo.
  if (method === "POST" && path === "/api/issues") {
    const body = await readBody(req);
    send(res, 201, createIssue(repoOf(q, body), body));
    return true;
  }

  // /api/issues/:ref… (résolution du code scopée par ?repo=)
  const issueMatch = path.match(/^\/api\/issues\/([^/]+)(\/comments|\/references)?$/);
  if (issueMatch) {
    const ref = decodeURIComponent(issueMatch[1]);
    const sub = issueMatch[2];
    const id = repoOf(q);

    if (!sub && method === "GET") {
      const issue = getIssue(id, ref);
      send(res, issue ? 200 : 404, issue || { error: "not_found", ref });
      return true;
    }
    if (!sub && method === "PATCH") {
      send(res, 200, updateIssue(id, ref, await readBody(req)));
      return true;
    }
    if (!sub && method === "DELETE") {
      send(res, 200, { deleted: deleteIssue(id, ref), ref });
      return true;
    }
    if (sub === "/comments" && method === "POST") {
      const { body } = await readBody(req);
      send(res, 201, addComment(id, ref, body));
      return true;
    }
    if (sub === "/references" && method === "POST") {
      const issue = getIssue(id, ref);
      if (!issue) return send(res, 404, { error: "not_found", ref }), true;
      const { path: p } = await readBody(req);
      addReference(issue.id, p, id);
      send(res, 201, getIssue(id, issue.id));
      return true;
    }
  }

  // DELETE /api/references/:id
  const refMatch = path.match(/^\/api\/references\/(\d+)$/);
  if (refMatch && method === "DELETE") {
    send(res, 200, { removed: removeReference(Number(refMatch[1]), repoOf(q)) });
    return true;
  }

  return false;
}
