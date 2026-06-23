// Test NODE-337 : modèle « page de graphe » + persistance (Option B = appartenance
// EXCLUSIVE). Un nœud appartient à UNE page ; un arbre partage la page de sa racine.
//   - page par défaut auto-créée, absorbe les nœuds non rattachés (backfill)
//   - une racine créée est rattachée à la page par défaut (ou à une page fournie)
//   - un enfant hérite de la page de son parent ; le sous-arbre suit
//   - déplacer un sous-arbre sous un parent d'une autre page le fait CHANGER de page
//   - CRUD : create/get/list (avec nodeCount) / update / delete
//   - deletePage réattache ses nœuds à la page par défaut ; la page par défaut est indestructible
//   - setNodePage déplace un sous-arbre vers une page
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire (trackers sous .trackers/).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-pages-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const {
  createRepo, createNode, getNode, moveNode,
  ensureDefaultPage, listPages, getPage, createPage, updatePage, deletePage, setNodePage,
} = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const repo = createRepo({ slug: "t-pages", name: "Test pages", localPath: TMP });
  const rid = repo.id;

  // ── Page par défaut ─────────────────────────────────────────────────────────
  const def = ensureDefaultPage(rid);
  check("page par défaut créée (is_default)", def.isDefault === true && def.id > 0);
  check("ensureDefaultPage idempotent", ensureDefaultPage(rid).id === def.id);

  // ── Création de nœuds : rattachement à la page par défaut + héritage ────────
  const root = createNode(rid, null, { title: "Racine" });
  check("racine rattachée à la page par défaut", getNode(root.id, { repoId: rid }).pageId === def.id);
  const child = createNode(rid, root.id, { title: "Enfant" });
  check("enfant hérite de la page du parent", getNode(child.id, { repoId: rid }).pageId === def.id);
  const grand = createNode(rid, child.id, { title: "Petit-enfant" });
  check("petit-enfant hérite aussi", getNode(grand.id, { repoId: rid }).pageId === def.id);

  // ── CRUD page + création d'une racine sur une page donnée ───────────────────
  const p2 = createPage(rid, { name: "Toile B", preprompt: "consigne B" });
  check("createPage", p2.id !== def.id && p2.name === "Toile B" && p2.isDefault === false);
  const rootB = createNode(rid, null, { title: "Racine B", pageId: p2.id });
  check("racine créée sur une page fournie", getNode(rootB.id, { repoId: rid }).pageId === p2.id);
  createNode(rid, rootB.id, { title: "Enfant B" });

  // listPages avec nodeCount (page défaut: root+child+grand = 3 ; p2: rootB+enfantB = 2).
  const pages = listPages(rid);
  const byId = Object.fromEntries(pages.map((p) => [p.id, p]));
  check("listPages renvoie les 2 pages", pages.length === 2);
  check("nodeCount page par défaut = 3", byId[def.id].nodeCount === 3);
  check("nodeCount page B = 2", byId[p2.id].nodeCount === 2);

  const upd = updatePage(p2.id, { name: "Toile B2", preprompt: "maj" }, rid);
  check("updatePage (name + preprompt)", upd.name === "Toile B2" && upd.preprompt === "maj");
  check("getPage relit", getPage(p2.id, rid).name === "Toile B2");

  // ── Déplacement entre pages : un sous-arbre déplacé sous une autre page change ─
  // Déplace `child` (sous-arbre child+grand) sous rootB (page B) → ils passent en page B.
  moveNode(child.id, rootB.id, null, rid);
  check("déplacement sous page B → enfant change de page", getNode(child.id, { repoId: rid }).pageId === p2.id);
  check("déplacement sous page B → petit-enfant suit", getNode(grand.id, { repoId: rid }).pageId === p2.id);
  check("la racine d'origine reste sur la page par défaut", getNode(root.id, { repoId: rid }).pageId === def.id);

  // ── setNodePage : rattache un sous-arbre à une page ─────────────────────────
  const p3 = createPage(rid, { name: "Toile C" });
  setNodePage(root.id, p3.id, rid);
  check("setNodePage déplace la racine vers la page C", getNode(root.id, { repoId: rid }).pageId === p3.id);

  // ── deletePage : réattache à la page par défaut ; défaut indestructible ─────
  const before = listPages(rid).find((p) => p.id === p3.id).nodeCount;
  check("page C a bien des nœuds avant suppression", before >= 1);
  const del = deletePage(p3.id, rid);
  check("deletePage ok + réattache", del.ok === true && del.reattached === before);
  check("nœuds de C revenus à la page par défaut", getNode(root.id, { repoId: rid }).pageId === def.id);
  check("page C supprimée", getPage(p3.id, rid) === null);

  const delDef = deletePage(def.id, rid);
  check("page par défaut INDESTRUCTIBLE", delDef.ok === false && delDef.reason === "page_par_defaut");

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
