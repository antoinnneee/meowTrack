// Test NODE-349 : un add_node RACINE depuis le chat forêt atterrit sur la PAGE ACTIVE.
// Avant, body.pageId servait au préprompt (NODE-340) mais n'était jamais propagé à
// applyForestActions → les racines créées par l'IA tombaient toujours sur la page par
// défaut. applyForestActions(repoId, actions, { pageId }) fixe désormais la page par
// défaut des racines sans pageId explicite (les enfants héritent toujours du parent).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-addpage-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, ensureDefaultPage, createPage, getNode, applyForestActions } = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };
const rootIdOf = (res) => (res.applied.find((a) => a.op === "add_node") || {}).id;

try {
  const repo = createRepo({ slug: "t-addpage", name: "Test add page", localPath: TMP });
  const rid = repo.id;
  const def = ensureDefaultPage(rid);
  const pB = createPage(rid, { name: "Page B" });

  // ── opts.pageId → racine sur la page active ─────────────────────────────────
  const r1 = applyForestActions(rid, [{ op: "add_node", title: "Racine active" }], { pageId: pB.id });
  check("racine créée avec opts.pageId → page active", getNode(rootIdOf(r1), { repoId: rid }).pageId === pB.id);

  // ── Sans opts → page par défaut (comportement historique) ───────────────────
  const r2 = applyForestActions(rid, [{ op: "add_node", title: "Racine défaut" }]);
  check("racine sans opts → page par défaut", getNode(rootIdOf(r2), { repoId: rid }).pageId === def.id);

  // ── opts.pageId = null (« Tout » sélectionné) → page par défaut ──────────────
  const r3 = applyForestActions(rid, [{ op: "add_node", title: "Racine Tout" }], { pageId: null });
  check("opts.pageId null → page par défaut", getNode(rootIdOf(r3), { repoId: rid }).pageId === def.id);

  // ── pageId explicite dans l'action l'emporte sur opts ───────────────────────
  const r4 = applyForestActions(rid, [{ op: "add_node", title: "Racine explicite", pageId: def.id }], { pageId: pB.id });
  check("pageId explicite de l'action gagne sur opts", getNode(rootIdOf(r4), { repoId: rid }).pageId === def.id);

  // ── Un ENFANT hérite de la page du parent, jamais d'opts.pageId ──────────────
  const parentOnB = applyForestActions(rid, [{ op: "add_node", title: "Parent B" }], { pageId: pB.id });
  const parentId = rootIdOf(parentOnB);
  const childRes = applyForestActions(rid, [{ op: "add_node", title: "Enfant", parentId }], { pageId: def.id });
  check("enfant hérite de la page du parent (ignore opts)", getNode(rootIdOf(childRes), { repoId: rid }).pageId === pB.id);

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
