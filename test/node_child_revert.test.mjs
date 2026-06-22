// Test NODE-324 : ajouter un sous-jalon NON terminé à un nœud 'done' le réactive
// (cas symétrique de NODE-323). Inséré dans _insertChild → impacte createNode
// (POST /api/nodes + action IA add_node). Un enfant ajouté déjà 'done' ne reverte pas.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-childrev-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, createNode, getNode, updateNode, applyNodeActions } = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

// Crée un nœud done (feuille → validable directement).
const doneNode = (rid, title) => {
  const n = createNode(rid, null, { title });
  return updateNode(n.id, { status: "done" }, undefined, rid);
};

try {
  const repo = createRepo({ slug: "t-childrev", name: "Test child revert", localPath: TMP });
  const rid = repo.id;

  // 1. Parent done → ajout d'un enfant (actif par défaut) → repasse active, done_at effacé.
  let parent = doneNode(rid, "Parent A");
  check("parent done au départ", parent.status === "done" && !!parent.doneAt);
  createNode(rid, parent.id, { title: "Nouvel enfant" });
  parent = getNode(parent.id, { repoId: rid });
  check("ajout d'enfant actif → parent réactivé", parent.status === "active" && parent.doneAt == null);

  // 2. Parent actif → ajout d'un enfant → reste actif (pas d'effet de bord).
  let act = createNode(rid, null, { title: "Parent actif" });
  createNode(rid, act.id, { title: "Enfant" });
  act = getNode(act.id, { repoId: rid });
  check("parent actif reste actif", act.status === "active");

  // 3. Chemin IA add_node : même revert.
  let p3 = doneNode(rid, "Parent C");
  const res = applyNodeActions(p3.id, [{ op: "add_node", parentId: p3.id, title: "Enfant IA" }], rid);
  check("action add_node appliquée", res.applied.length === 1);
  p3 = getNode(p3.id, { repoId: rid });
  check("ajout via IA → parent réactivé", p3.status === "active");

  // 4. Ajout d'un enfant DÉJÀ done → la complétude est préservée → parent reste done.
  let p4 = doneNode(rid, "Parent D");
  createNode(rid, p4.id, { title: "Enfant déjà fait", status: "done" });
  p4 = getNode(p4.id, { repoId: rid });
  check("ajout d'un enfant done → parent reste done", p4.status === "done");

  // 5. Racine done + sous-arbre : ajout en profondeur réactive le parent direct.
  let root = doneNode(rid, "Racine");
  const mid = createNode(rid, root.id, { title: "Intermédiaire" }); // réactive root
  root = getNode(root.id, { repoId: rid });
  check("ajout sous racine done → racine réactivée", root.status === "active");

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
