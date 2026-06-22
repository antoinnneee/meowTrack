// Test NODE-323 : interdiction de valider (done) un nœud tant qu'un enfant direct
// n'est pas terminé. Guard dans _setNodeFields → impacte updateNode (PATCH/IA) ;
// transparent pour completeNode (feuilles) et l'auto-promotion (UPDATE SQL direct).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-guard-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, createNode, getNode, updateNode, applyNodeActions, startNode, completeNode } = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const repo = createRepo({ slug: "t-guard", name: "Test guard", localPath: TMP });
  const rid = repo.id;

  // Parent avec un enfant actif → validation refusée.
  const parent = createNode(rid, null, { title: "Objectif" });
  const child = createNode(rid, parent.id, { title: "Sous-jalon" });
  let threw = false, msg = "";
  try { updateNode(parent.id, { status: "done" }, undefined, rid); } catch (e) { threw = true; msg = e.message; }
  check("parent à enfant incomplet : done refusé", threw && /sous-jalon/i.test(msg));
  check("parent reste non-done après refus", getNode(parent.id, { repoId: rid }).status !== "done");

  // Chemin IA (set_node_fields) : même refus, capturé en rejected.
  const res = applyNodeActions(parent.id, [{ op: "set_node_fields", status: "done" }], rid);
  check("IA set_node_fields done refusé (rejected)", res.applied.length === 0 && res.rejected.length === 1 && /sous-jalon/i.test(res.rejected[0].reason));

  // Une feuille (sans enfant) se valide normalement.
  const leaf = createNode(rid, null, { title: "Tâche seule" });
  let leafOk = true;
  try { updateNode(leaf.id, { status: "done" }, undefined, rid); } catch { leafOk = false; }
  check("feuille sans enfant : done accepté", leafOk && getNode(leaf.id, { repoId: rid }).status === "done");

  // Node d'activation sans enfant : done (= activé) accepté.
  const gate = createNode(rid, null, { title: "Porte", kind: "activation" });
  let gateOk = true;
  try { updateNode(gate.id, { status: "done" }, undefined, rid); } catch { gateOk = false; }
  check("node d'activation sans enfant : done accepté", gateOk);

  // L'enfant terminé débloque la validation du parent.
  updateNode(child.id, { status: "done" }, undefined, rid);
  let parentOk = true;
  try { updateNode(parent.id, { status: "done" }, undefined, rid); } catch { parentOk = false; }
  check("parent validable une fois l'enfant terminé", parentOk && getNode(parent.id, { repoId: rid }).status === "done");

  // completeNode sur une feuille réclamée : non bloqué (aucun enfant).
  const p2 = createNode(rid, null, { title: "Objectif 2" });
  const leaf2 = createNode(rid, p2.id, { title: "Feuille 2" });
  startNode(leaf2.id, "w1", {}, rid);
  let completeOk = true;
  try { completeNode(leaf2.id, "w1", { summary: "fait" }, rid); } catch { completeOk = false; }
  check("completeNode sur feuille : non bloqué", completeOk && getNode(leaf2.id, { repoId: rid }).status === "done");

  // Auto-promotion : le parent p2 (tous enfants done) remonte à done via SQL direct,
  // sans passer par le guard.
  check("auto-promotion du parent (bypass guard)", getNode(p2.id, { repoId: rid }).status === "done");

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
