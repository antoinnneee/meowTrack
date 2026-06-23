// routes/templates.js — surface HTTP du CRUD des TEMPLATES DE PRÉPROMPT (NODE-339).
//
// Adaptateur mince sur db/templates.js (data layer). Per-dépôt via ?repo= (injecté
// par le front) ; omis → repo par défaut. Aucune logique métier ici.
//
//   GET    /api/templates           → liste des templates du repo
//   POST   /api/templates           { name, body }        → crée
//   GET    /api/templates/:id        → un template
//   PATCH  /api/templates/:id        { name?, body? }     → met à jour (partiel)
//   DELETE /api/templates/:id        → supprime

import { send, readBody, repoOf } from "../http-util.js";
import { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate } from "../db.js";

export async function handle(ctx) {
  const { req, res, method, path, q } = ctx;

  if (path === "/api/templates") {
    const repoId = repoOf(q);
    if (method === "GET") {
      send(res, 200, { templates: listTemplates(repoId) });
      return true;
    }
    if (method === "POST") {
      const body = await readBody(req);
      const t = createTemplate(repoId, { name: body.name, body: body.body });
      send(res, 200, t);
      return true;
    }
    return false;
  }

  const m = path.match(/^\/api\/templates\/(\d+)$/);
  if (m) {
    const repoId = repoOf(q);
    const id = Number(m[1]);
    if (method === "GET") {
      const t = getTemplate(id, repoId);
      send(res, t ? 200 : 404, t || { error: "introuvable" });
      return true;
    }
    if (method === "PATCH" || method === "PUT") {
      const body = await readBody(req);
      const t = updateTemplate(id, { name: body.name, body: body.body }, repoId);
      send(res, t ? 200 : 404, t || { error: "introuvable" });
      return true;
    }
    if (method === "DELETE") {
      const removed = deleteTemplate(id, repoId);
      send(res, removed ? 200 : 404, removed ? { ok: true, removed } : { error: "introuvable" });
      return true;
    }
  }

  return false;
}
