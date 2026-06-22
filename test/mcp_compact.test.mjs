// Test NODE-299 : compaction + pagination des grandes listes MCP.
// meowtrack_list et meowtrack_node_list projettent par défaut les champs utiles
// et paginent ({total, offset, count, items}) ; `full:true` rend l'objet brut ;
// `offset` saute les N premiers ; includeNotes ajoute `notes` à la projection.
import { registerMeowtrackTools } from "../mcp-tools.js";

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

// Stub McpServer : capture les handlers par nom.
const handlers = {};
const server = { registerTool: (name, _cfg, handler) => { handlers[name] = handler; } };

// Faux backend REST.
const ISSUES = [
  { id: 1, ref: "BUG-1", type: "bug", title: "A", status: "open", priority: "high", branch: "main", updatedAt: "t1", description: "longue desc", references: [{ id: 9 }], nodes: [{ id: 2 }], tags: ["x"] },
  { id: 2, ref: "FEAT-2", type: "feature", title: "B", status: "done", priority: "low", branch: null, updatedAt: "t2", description: "x", references: [], nodes: [], tags: [] },
];
const NODES = [
  { id: 1, ref: "NODE-1", parentId: null, depth: 0, title: "Root", status: "active", kind: "normal", progress: 0, childCount: 1, position: 0, notes: [{ title: "n", body: "b" }], description: "d", posX: 12, version: 3 },
  { id: 2, ref: "NODE-2", parentId: 1, depth: 1, title: "Child", status: "done", kind: "normal", progress: 100, childCount: 0, position: 0, notes: [], description: "d2", posX: null, version: 4 },
];
async function apiFetch(method, path) {
  if (path.startsWith("/api/issues")) return ISSUES;
  if (path.startsWith("/api/nodes")) return NODES;
  throw new Error("path inattendu: " + path);
}

const parse = async (name, args) => JSON.parse((await handlers[name](args)).content[0].text);

try {
  registerMeowtrackTools(server, { apiFetch, defaultRepo: "" });

  // ── meowtrack_list ──────────────────────────────────────────────────────────
  let r = await parse("meowtrack_list", {});
  check("list compact : forme paginée", r.total === 2 && r.offset === 0 && r.count === 2 && Array.isArray(r.items));
  const it = r.items[0];
  check("list compact : champs projetés", it.ref === "BUG-1" && it.title === "A" && it.status === "open" && it.priority === "high");
  check("list compact : champs lourds supprimés", !("description" in it) && !("references" in it) && !("nodes" in it) && !("tags" in it));

  r = await parse("meowtrack_list", { offset: 1 });
  check("list offset : saute le premier", r.total === 2 && r.offset === 1 && r.count === 1 && r.items[0].ref === "FEAT-2");

  r = await parse("meowtrack_list", { full: true });
  check("list full : tableau brut complet", Array.isArray(r) && r.length === 2 && r[0].description === "longue desc" && Array.isArray(r[0].references));

  // ── meowtrack_node_list ───────────────────────────────────────────────────────
  r = await parse("meowtrack_node_list", {});
  check("node_list compact : forme paginée", r.total === 2 && r.count === 2);
  const n = r.items[0];
  check("node_list compact : champs projetés", n.ref === "NODE-1" && n.parentId === null && n.depth === 0 && n.progress === 0 && n.kind === "normal");
  check("node_list compact : champs lourds supprimés", !("notes" in n) && !("description" in n) && !("posX" in n) && !("version" in n));

  r = await parse("meowtrack_node_list", { includeNotes: true });
  check("node_list includeNotes : notes incluses", "notes" in r.items[0] && !("description" in r.items[0]));

  r = await parse("meowtrack_node_list", { full: true });
  check("node_list full : tableau brut complet", Array.isArray(r) && r[0].version === 3 && Array.isArray(r[0].notes));

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
