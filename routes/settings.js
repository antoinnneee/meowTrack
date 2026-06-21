// routes/settings.js — réglages d'instance éditables depuis l'UI.
//
// Pour l'instant : la configuration de l'ORCHESTRATEUR (bail, retries, branche de
// travail, commande de test, auto-revue…). Précédence env → global → override repo
// résolue dans db/registry.js ; ce module n'est qu'un adaptateur HTTP mince. Les
// secrets/token ne transitent JAMAIS par ici (allowlist de clés côté data layer).

import { send, readBody, repoOf } from "../http-util.js";
import { getOrchestratorConfig, setOrchestratorConfig } from "../db.js";

export async function handle(ctx) {
  const { req, res, method, path, q } = ctx;

  if (path === "/api/settings/orchestrator") {
    // GET ?repo= — config EFFECTIVE d'un repo + origine de chaque valeur.
    if (method === "GET") {
      send(res, 200, getOrchestratorConfig(repoOf(q)));
      return true;
    }
    // PUT { scope:'global'|'repo', repo?, patch } — écrit la config (allowlist + bornes).
    if (method === "PUT" || method === "POST") {
      const body = await readBody(req);
      const scope = body.scope === "repo" ? "repo" : "global";
      const repoId = scope === "repo" ? repoOf(q, body) : null;
      try {
        const cfg = setOrchestratorConfig(body.patch || {}, { scope, repoId });
        send(res, 200, cfg);
      } catch (e) {
        send(res, 400, { error: "config_invalide", message: e.message });
      }
      return true;
    }
  }

  return false;
}
