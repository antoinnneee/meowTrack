// Test du domaine SUIVI étendu : ordre manuel (`position`), reorderIssues, et les
// actions IA sur les issues (applyIssueActions : add/update/delete/reorder, fail-closed).
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire (trackers sous .trackers/).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-issues-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const {
  createRepo,
  createIssue,
  getIssue,
  listIssues,
  reorderIssues,
  applyIssueActions,
} = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };
const refsOf = (list) => list.map((i) => i.ref);

try {
  const repo = createRepo({ slug: "t-issues", name: "Test issues", localPath: TMP });
  const rid = repo.id;

  // Création : positions incrémentales (0,1,2) = ordre d'ajout (bas de liste).
  const a = createIssue(rid, { title: "Première", type: "bug" });
  const b = createIssue(rid, { title: "Deuxième", type: "feature" });
  const c = createIssue(rid, { title: "Troisième", type: "task" });
  check("positions incrémentales 0/1/2", a.position === 0 && b.position === 1 && c.position === 2);

  // listIssues : tri par position ASC.
  let list = listIssues(rid, {});
  check("ordre initial = [a,b,c]", JSON.stringify(refsOf(list)) === JSON.stringify([a.ref, b.ref, c.ref]));

  // reorderIssues : ordre inversé via codes.
  reorderIssues(rid, [c.ref, b.ref, a.ref]);
  list = listIssues(rid, {});
  check("après reorder = [c,b,a]", JSON.stringify(refsOf(list)) === JSON.stringify([c.ref, b.ref, a.ref]));
  check("positions réécrites 0/1/2", listIssues(rid, {}).every((it, i) => it.position === i));

  // reorder partiel : seul `a` cité → passe en tête, le reste garde son ordre relatif.
  reorderIssues(rid, [a.ref]);
  list = listIssues(rid, {});
  check("reorder partiel place a en tête", list[0].ref === a.ref);

  // ── Actions IA : add_issue ───────────────────────────────────────────────────
  let res = applyIssueActions(rid, [{ op: "add_issue", title: "Créée par IA", type: "chore", priority: "high" }]);
  check("add_issue appliqué + issuesChanged", res.applied.length === 1 && res.applied[0].op === "add_issue" && res.issuesChanged === true);
  const created = res.applied[0];
  const fetched = getIssue(rid, created.ref);
  check("add_issue → entrée persistée", fetched && fetched.type === "chore" && fetched.priority === "high" && fetched.title === "Créée par IA");

  // ── update_issue ─────────────────────────────────────────────────────────────
  res = applyIssueActions(rid, [{ op: "update_issue", ref: a.ref, status: "in_progress", priority: "critical" }]);
  check("update_issue appliqué", res.applied.length === 1 && res.issuesChanged === true);
  const ua = getIssue(rid, a.ref);
  check("update_issue → champs modifiés", ua.status === "in_progress" && ua.priority === "critical");

  // update_issue sans ref → rejeté (fail-closed), pas d'effet.
  res = applyIssueActions(rid, [{ op: "update_issue", status: "done" }]);
  check("update_issue sans ref rejeté", res.applied.length === 0 && res.rejected.some((r) => r.reason === "ref_requise"));

  // ── reorder_issues via action ────────────────────────────────────────────────
  res = applyIssueActions(rid, [{ op: "reorder_issues", order: [c.ref, b.ref, a.ref] }]);
  check("reorder_issues appliqué", res.applied.length === 1 && res.issuesChanged === true);
  list = listIssues(rid, {});
  check("reorder_issues effectif (c avant a)", refsOf(list).indexOf(c.ref) < refsOf(list).indexOf(a.ref));

  // ── delete_issue ─────────────────────────────────────────────────────────────
  res = applyIssueActions(rid, [{ op: "delete_issue", ref: b.ref }]);
  check("delete_issue appliqué", res.applied.length === 1 && res.issuesChanged === true);
  check("delete_issue → entrée disparue", getIssue(rid, b.ref) == null);

  // delete_issue introuvable → rejeté, pas d'effet.
  res = applyIssueActions(rid, [{ op: "delete_issue", ref: "BUG-999" }]);
  check("delete_issue introuvable rejeté", res.applied.length === 0 && res.rejected.some((r) => r.reason === "introuvable"));

  // ── op inconnu → rejeté (catalogue fermé) ────────────────────────────────────
  res = applyIssueActions(rid, [{ op: "frobnicate_issue", ref: a.ref }]);
  check("op inconnu rejeté", res.applied.length === 0 && res.rejected.some((r) => r.reason === "op_inconnu") && res.issuesChanged === false);

  console.log(`\n${pass} OK, ${fail} échec(s)`);
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(fail ? 1 : 0);
