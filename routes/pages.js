// routes/pages.js — surface HTTP des PAGES DE GRAPHE (NODE-337, appartenance exclusive).
//
// Adaptateur mince sur db/pages.js. Per-dépôt via ?repo= (injecté par le front) ;
// omis → repo par défaut.
//
//   GET    /api/pages                → { pages } (avec nodeCount, page par défaut incluse)
//   POST   /api/pages                { name, position?, templateId?, preprompt? } → crée
//   GET    /api/pages/:id            → une page
//   PATCH  /api/pages/:id            { name?, position?, templateId?, preprompt? }  → màj
//   DELETE /api/pages/:id            → supprime (réattache ses nœuds à la page par défaut ;
//                                       refuse la page par défaut → 409)
//   POST   /api/pages/:id/nodes      { nodeId } → rattache un nœud (et son sous-arbre)

import { send, readBody, repoOf } from "../http-util.js";
import { listPages, getPage, createPage, updatePage, deletePage, setNodePage } from "../db.js";

export async function handle(ctx) {
  const { req, res, method, path, q } = ctx;

  if (path === "/api/pages") {
    const repoId = repoOf(q);
    if (method === "GET") {
      send(res, 200, { pages: listPages(repoId) });
      return true;
    }
    if (method === "POST") {
      const b = await readBody(req);
      send(res, 200, createPage(repoId, { name: b.name, position: b.position, templateId: b.templateId, preprompt: b.preprompt }));
      return true;
    }
    return false;
  }

  const assign = path.match(/^\/api\/pages\/(\d+)\/nodes$/);
  if (assign && method === "POST") {
    const b = await readBody(req);
    try {
      send(res, 200, setNodePage(Number(b.nodeId), Number(assign[1]), repoOf(q)));
    } catch (e) {
      send(res, 400, { error: e.message });
    }
    return true;
  }

  const m = path.match(/^\/api\/pages\/(\d+)$/);
  if (m) {
    const repoId = repoOf(q);
    const id = Number(m[1]);
    if (method === "GET") {
      const p = getPage(id, repoId);
      send(res, p ? 200 : 404, p || { error: "introuvable" });
      return true;
    }
    if (method === "PATCH" || method === "PUT") {
      const b = await readBody(req);
      const p = updatePage(id, { name: b.name, position: b.position, templateId: b.templateId, preprompt: b.preprompt }, repoId);
      send(res, p ? 200 : 404, p || { error: "introuvable" });
      return true;
    }
    if (method === "DELETE") {
      const r = deletePage(id, repoId);
      if (r.ok) send(res, 200, r);
      else send(res, r.reason === "page_par_defaut" ? 409 : 404, { error: r.reason });
      return true;
    }
  }

  return false;
}
