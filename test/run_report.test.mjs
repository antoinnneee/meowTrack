// Test de l'ingestion des rapports (orchestrateur, §6) : fail-closed sur un rapport
// illisible ; nodeUpdates non destructifs appliqués selon autoApplyUpdates ; action
// destructive toujours PROPOSÉE (jamais auto-appliquée) ; reviewPoints persistés ; un
// point bloquant met la tâche en revue, sa résolution la promeut review→done.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "meow-report-"));
process.env.MEOWTRACK_DB = join(dir, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";
console.error = () => {};

const db = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

const rid = db.listRepos()[0].id;

// 1. FAIL-CLOSED : rapport non-objet / champs malformés → 0 action.
const pa = db.createNode(rid, null, { title: "PA" });
const f1 = db.ingestRunReport(pa.id, null, "pas un objet", rid);
check("rapport non-objet → 0 action, 0 revue", f1.applied.length === 0 && f1.reviews.length === 0 && f1.hasBlockingReview === false);
const f2 = db.ingestRunReport(pa.id, null, { nodeUpdates: "pas un tableau", reviewPoints: 42 }, rid);
check("champs malformés → 0 action", f2.applied.length === 0 && f2.reviews.length === 0);

// 2. nodeUpdate NON destructif appliqué quand autoApplyUpdates = true.
db.setOrchestratorConfig({ autoApplyUpdates: true }, { scope: "global" });
const p = db.createNode(rid, null, { title: "P" });
const i1 = db.ingestRunReport(p.id, null, { nodeUpdates: [{ op: "set_node_fields", description: "maj agent" }] }, rid);
check("nodeUpdate non destructif appliqué (autoApply on)", i1.applied.length === 1);
check("description effectivement mise à jour", db.getNode(p.id, { repoId: rid }).description === "maj agent");

// 3. autoApplyUpdates = false → non appliqué, mais PROPOSÉ en revue.
db.setOrchestratorConfig({ autoApplyUpdates: false }, { scope: "global" });
const p2 = db.createNode(rid, null, { title: "P2" });
const i2 = db.ingestRunReport(p2.id, null, { nodeUpdates: [{ op: "set_node_fields", description: "à confirmer" }] }, rid);
check("autoApply off → non appliqué", i2.applied.length === 0);
check("autoApply off → proposé en revue", i2.reviews.length === 1 && i2.reviews[0].suggested.length === 1);
check("description inchangée", db.getNode(p2.id, { repoId: rid }).description !== "à confirmer");

// 4. action DESTRUCTIVE toujours proposée (même avec autoApply on).
db.setOrchestratorConfig({ autoApplyUpdates: true }, { scope: "global" });
const pc = db.createNode(rid, null, { title: "PC" });
const cc = db.createNode(rid, pc.id, { title: "CC" });
const i3 = db.ingestRunReport(pc.id, null, { nodeUpdates: [{ op: "delete_node", id: cc.id }] }, rid);
check("action destructive NON appliquée (nœud encore là)", db.getNode(cc.id, { repoId: rid }) !== null);
check("action destructive proposée en revue", i3.reviews.some((r) => r.suggested.some((s) => s.op === "delete_node")));

// 5. reviewPoints persistés ; point bloquant → review ; résolution → done.
const rd = db.createRepo({ slug: "rd" });
const rootD = db.createNode(rd.id, null, { title: "RD" });
const leaf = db.createNode(rd.id, rootD.id, { title: "L" });
const claimed = db.claimNextNode(rd.id, "w1");
check("claim L", claimed && claimed.id === leaf.id);
const runId = db.currentRunId(leaf.id, "w1", rd.id);
const ing = db.ingestRunReport(leaf.id, runId, { reviewPoints: [{ kind: "decision", message: "REST ou WebSocket ?", blocking: true }] }, rd.id);
check("reviewPoint persisté", ing.reviews.length === 1 && ing.reviews[0].message.includes("REST"));
check("point bloquant détecté", ing.hasBlockingReview === true);
const comp = db.completeNode(leaf.id, "w1", { hasBlockingReview: ing.hasBlockingReview }, rd.id);
check("complete avec point bloquant → review", comp.state === "review");
const openReviews = db.listReviews({ ref: leaf.id, state: "open", repoId: rd.id });
check("point de revue ouvert listé", openReviews.length === 1);
const res = db.resolveReview(openReviews[0].id, { decision: "approve", applyActions: false }, rd.id);
check("résolution promeut review→done", res.promoted === true && db.getNode(leaf.id, { repoId: rd.id }).status === "done");

console.log(`\n${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
