// Test NODE-342 : DÉPLACER un nœud non terminé sous un objectif 'done' le réactive
// (cas symétrique de NODE-324 qui ne couvre que la création d'un enfant). Inséré dans
// moveNode → impacte le drag & drop (POST /api/nodes/:ref/move) ET l'action IA move_node.
// Pas de revert si le nœud déplacé est 'done', ni à la remontée en racine.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-moverev-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, createNode, getNode, updateNode, moveNode, applyForestActions } = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

// Nœud done (feuille → validable directement).
const doneNode = (rid, title) => {
  const n = createNode(rid, null, { title });
  return updateNode(n.id, { status: "done" }, undefined, rid);
};

try {
  const repo = createRepo({ slug: "t-moverev", name: "Test move revert", localPath: TMP });
  const rid = repo.id;

  // 1. Déplacer un nœud ACTIF sous un objectif done → objectif réactivé, done_at effacé.
  let target = doneNode(rid, "Objectif done");
  const mover = createNode(rid, null, { title: "Nœud actif" });
  moveNode(mover.id, target.id, null, rid);
  target = getNode(target.id, { repoId: rid });
  check("déplacement d'un nœud actif sous done → réactivé", target.status === "active" && target.doneAt == null);
  check("le nœud déplacé est bien rattaché", getNode(mover.id, { repoId: rid }).parentId === target.id);

  // 2. Déplacer un nœud DÉJÀ done sous un objectif done → reste done (complétude préservée).
  let target2 = doneNode(rid, "Objectif done 2");
  const moverDone = doneNode(rid, "Nœud done");
  moveNode(moverDone.id, target2.id, null, rid);
  target2 = getNode(target2.id, { repoId: rid });
  check("déplacement d'un nœud done sous done → reste done", target2.status === "done");

  // 3. Remontée en RACINE (newParentId null) → pas de parent, aucun revert, pas d'erreur.
  let host = doneNode(rid, "Hôte done");
  const child = createNode(rid, host.id, { title: "Enfant à remonter" }); // réactive host (NODE-324)
  host = getNode(host.id, { repoId: rid });
  check("ajout d'enfant a réactivé l'hôte (NODE-324)", host.status === "active");
  updateNode(child.id, { status: "done" }, undefined, rid); // enfant done
  // re-valider l'hôte : il n'a qu'un enfant done → autorisé
  host = updateNode(host.id, { status: "done" }, undefined, rid);
  check("hôte re-validé done", host.status === "done");
  const moved = moveNode(child.id, null, null, rid); // remonte l'enfant done en racine
  check("remontée en racine sans erreur (parentId null)", moved.parentId == null);
  host = getNode(host.id, { repoId: rid });
  check("l'ancien parent (rollup monotone) reste done", host.status === "done");

  // 4. Chemin IA move_node (applyForestActions) : même revert.
  let t4 = doneNode(rid, "Cible IA done");
  const m4 = createNode(rid, null, { title: "À déplacer par IA" });
  const res = applyForestActions(rid, [{ op: "move_node", id: m4.id, parentId: t4.id }]);
  check("action move_node appliquée", res.applied.length === 1);
  t4 = getNode(t4.id, { repoId: rid });
  check("déplacement via IA sous done → réactivé", t4.status === "active");

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
