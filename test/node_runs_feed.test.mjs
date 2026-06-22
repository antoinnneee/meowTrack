// Test NODE-318 : flux repo-level des runs (listRecentRuns) — base du futur onglet
// Suivi « activité des agents ». Vérifie : tous les runs du repo (pas seulement un
// nœud), tri récent→ancien, jointure nodeRef/nodeTitle, filtre d'état, pagination.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-runs-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, createNode, startNode, completeNode, failNode, listRecentRuns } = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const repo = createRepo({ slug: "t-runs", name: "Test runs", localPath: TMP });
  const rid = repo.id;

  const a = createNode(rid, null, { title: "Tâche A" });
  const b = createNode(rid, null, { title: "Tâche B" });
  const c = createNode(rid, null, { title: "Tâche C" });

  // 3 runs sur des nœuds différents : 2 done, 1 failed, + 1 running encore ouvert.
  startNode(a.id, "w1", {}, rid);
  completeNode(a.id, "w1", { summary: "fait A", branch: "meow/A", testResult: "pass" }, rid);
  startNode(b.id, "w1", {}, rid);
  completeNode(b.id, "w1", { summary: "fait B", branch: "meow/B" }, rid);
  startNode(c.id, "w2", {}, rid);
  failNode(c.id, "w2", { error: "boom", branch: "meow/C" }, rid);
  // Nouvelle tentative sur C (failed → redémarrable) : un run encore en cours.
  startNode(c.id, "w3", {}, rid);

  const all = listRecentRuns({ repoId: rid });
  check("liste tous les runs du repo", all.length === 4);
  check("jointure nodeRef/nodeTitle présente", all.every((r) => r.nodeRef && r.nodeTitle));
  check("tri récent → ancien (run C running en tête)", all[0].state === "running" && all[0].nodeRef === c.ref);
  check("états variés capturés", all.some((r) => r.state === "done") && all.some((r) => r.state === "failed"));

  // Filtre d'état.
  const done = listRecentRuns({ repoId: rid, state: "done" });
  check("filtre state=done", done.length === 2 && done.every((r) => r.state === "done"));
  const failed = listRecentRuns({ repoId: rid, state: "failed" });
  check("filtre state=failed", failed.length === 1 && failed[0].error === "boom");

  // Pagination.
  const page = listRecentRuns({ repoId: rid, limit: 2 });
  check("limit borne le nombre de runs", page.length === 2);
  const offset = listRecentRuns({ repoId: rid, limit: 2, offset: 2 });
  check("offset décale la fenêtre", offset.length === 2 && offset[0].id !== page[0].id);

  // Scope repo : un autre repo ne voit pas ces runs.
  const repo2 = createRepo({ slug: "t-runs2", name: "Autre", localPath: TMP });
  check("scope repo (autre repo vide)", listRecentRuns({ repoId: repo2.id }).length === 0);

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
