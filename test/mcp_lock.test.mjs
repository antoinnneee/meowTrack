// Test NODE-301 : verrou mono-repo du transport MCP (MEOWTRACK_LOCK_REPO).
// Quand lockRepo est défini : repo divergent rejeté ; repo omis → repo verrouillé ;
// slug OU id du dépôt verrouillé acceptés ; meowtrack_repos ne révèle que le verrou.
// Sans lock : comportement inchangé.
import { registerMeowtrackTools } from "../mcp-tools.js";

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

const REPOS = [
  { id: 1, slug: "meownopoly", name: "meownopoly" },
  { id: 2, slug: "meowtrack", name: "meowtrack" },
  { id: 3, slug: "florapin", name: "florapin" },
];

// Construit un jeu d'outils avec un apiFetch qui ENREGISTRE les chemins appelés.
function build({ lockRepo }) {
  const calls = [];
  const handlers = {};
  const server = { registerTool: (name, _cfg, h) => { handlers[name] = h; } };
  const apiFetch = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (path.startsWith("/api/repos")) return REPOS;
    if (path.startsWith("/api/nodes")) return [{ id: 9, ref: "NODE-9", title: "x", status: "active" }];
    return {};
  };
  registerMeowtrackTools(server, { apiFetch, lockRepo });
  const call = (name, args) => handlers[name](args);
  return { handlers, calls, call };
}
const result = async (p) => {
  const o = await p;
  const text = o.content[0].text;
  return { isError: !!o.isError, data: o.isError ? null : JSON.parse(text), text };
};

try {
  // ── Verrou actif (lock = slug "meowtrack") ──────────────────────────────────
  {
    const { calls, call } = build({ lockRepo: "meowtrack" });

    // repo divergent (slug) → rejeté, AUCUN appel API node effectué.
    let r = await result(call("meowtrack_node_list", { repo: "meownopoly" }));
    check("lock : repo divergent (slug) rejeté", r.isError && /verrouillé/i.test(r.text));
    check("lock : aucun appel /api/nodes pour un repo divergent", !calls.some((c) => c.includes("/api/nodes")));

    // repo divergent (id) → rejeté.
    r = await result(call("meowtrack_node_list", { repo: 1 }));
    check("lock : repo divergent (id) rejeté", r.isError);

    // repo omis → accepté ; le chemin porte le repo verrouillé.
    r = await result(call("meowtrack_node_list", {}));
    check("lock : repo omis accepté", !r.isError);
    check("lock : repo omis force le repo verrouillé dans la requête", calls.some((c) => c.includes("repo=meowtrack")));

    // repo == lock par slug → accepté.
    r = await result(call("meowtrack_node_list", { repo: "meowtrack" }));
    check("lock : slug verrouillé accepté", !r.isError);

    // repo == lock par id (2) → accepté (résolu via /api/repos).
    r = await result(call("meowtrack_node_list", { repo: 2 }));
    check("lock : id équivalent au slug verrouillé accepté", !r.isError);

    // meowtrack_repos ne révèle QUE le dépôt verrouillé.
    r = await result(call("meowtrack_repos", {}));
    check("lock : meowtrack_repos filtré au seul verrou", Array.isArray(r.data) && r.data.length === 1 && r.data[0].slug === "meowtrack");
  }

  // ── Sans verrou : comportement inchangé ──────────────────────────────────────
  {
    const { call } = build({ lockRepo: "" });
    let r = await result(call("meowtrack_node_list", { repo: "meownopoly" }));
    check("sans lock : repo arbitraire accepté", !r.isError);
    r = await result(call("meowtrack_repos", {}));
    check("sans lock : meowtrack_repos renvoie tous les repos", Array.isArray(r.data) && r.data.length === 3);
  }

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
