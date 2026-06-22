// Test NODE-322 : éditer le titre ou la description d'un nœud TERMINÉ le réactive
// automatiquement (done → active, done_at effacé, progression remise à 0). Les
// notes (écrites par la clôture MCP sur un nœud done) et les champs cosmétiques
// ne déclenchent PAS le revert ; un `status` explicite de l'appelant a priorité.
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-revert-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, createNode, getNode, updateNode, applyNodeActions } = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

const done = (rid, title) => {
  const n = createNode(rid, null, { title });
  return updateNode(n.id, { status: "done" }, undefined, rid);
};

try {
  const repo = createRepo({ slug: "t-revert", name: "Test revert", localPath: TMP });
  const rid = repo.id;

  // 1. Nœud done → édition du titre → repasse active (done_at effacé, progress 0).
  let n = done(rid, "Tâche A");
  check("nœud done (progress 100, done_at posé)", n.status === "done" && n.progress === 100 && !!n.doneAt);
  n = updateNode(n.id, { title: "Tâche A renommée" }, undefined, rid);
  check("édition titre → active", n.status === "active" && n.title === "Tâche A renommée");
  check("done_at effacé", n.doneAt == null);
  check("progress remis à 0", n.progress === 0);

  // 2. Nœud done → édition de la description (via action IA set_node_fields) → active.
  n = done(rid, "Tâche B");
  const res = applyNodeActions(n.id, [{ op: "set_node_fields", description: "Nouvelle description" }], rid);
  check("action IA appliquée", res.applied.length === 1);
  n = getNode(n.id, { repoId: rid });
  check("édition description IA → active", n.status === "active" && n.description === "Nouvelle description");

  // 3. Nœud done → écriture de NOTES seules (clôture MCP) → reste done.
  n = done(rid, "Tâche C");
  n = updateNode(n.id, { notes: "## Récap\nFait." }, undefined, rid);
  check("notes seules → reste done", n.status === "done" && !!n.doneAt);

  // 4. Nœud done → champs cosmétiques (emoji/color) → reste done.
  n = done(rid, "Tâche D");
  n = updateNode(n.id, { emoji: "🚀", color: "feature" }, undefined, rid);
  check("cosmétiques → reste done", n.status === "done");

  // 5. Nœud done → status explicite fourni avec un titre → la consigne de l'appelant prime.
  n = done(rid, "Tâche E");
  n = updateNode(n.id, { title: "E renommée", status: "abandoned" }, undefined, rid);
  check("status explicite prime sur le revert", n.status === "abandoned");

  // 6. Nœud NON done → édition titre → statut inchangé (pas de promotion parasite).
  let p = createNode(rid, null, { title: "Tâche F" });
  p = updateNode(p.id, { status: "paused" }, undefined, rid);
  p = updateNode(p.id, { title: "F renommée" }, undefined, rid);
  check("nœud paused édité → reste paused", p.status === "paused");

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
