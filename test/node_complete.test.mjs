// Test de la clôture de tâches (orchestrateur) : completeNode met 'done', fait
// remonter la progression et débloque un dépendant ; la clôture par un non-détenteur
// échoue (lease_lost) ; hasBlockingReview met la tâche en 'review' (pas de déblocage).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "meow-complete-"));
process.env.MEOWTRACK_DB = join(dir, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";
console.error = () => {};

const db = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

const rid = db.listRepos()[0].id;
const root = db.createNode(rid, null, { title: "Racine" });
const a = db.createNode(rid, root.id, { title: "A" });
const b = db.createNode(rid, root.id, { title: "B" });
db.addNodeLink(b.id, a.id, { repoId: rid }); // B dépend de A

// 1. complete met le statut done + done_at + remonte la progression.
const claimed = db.claimNextNode(rid, "w1");
const r = db.completeNode(claimed.id, "w1", { summary: "fait", testResult: "pass" });
check("complete renvoie state=done", r.state === "done");
const aAfter = db.getNode(a.id, { repoId: rid });
check("statut passé à done", aAfter.status === "done");
check("done_at renseigné", !!aAfter.doneAt);
const rootAfter = db.getNode(root.id, { repoId: rid });
check("progression de la racine remontée (1/2 enfants done = 50)", rootAfter.progress === 50);
check("run enregistré 'done'", db.listRuns(a.id, rid)[0].state === "done");

// 2. clôture par un NON-détenteur du bail → lease_lost.
const c = db.createNode(rid, root.id, { title: "C" });
const claimedC = db.claimNextNode(rid, "w2");
let leaseLost = false;
try {
  db.completeNode(claimedC.id, "intrus", { summary: "x" });
} catch (e) {
  leaseLost = e.code === "lease_lost";
}
check("clôture par un non-détenteur → lease_lost", leaseLost);
check("le nœud reste running (non clôturé)", db.getNode(claimedC.id, { repoId: rid }).runState === "running");

// 3. hasBlockingReview → 'review' (ne débloque PAS les dépendants). Repo isolé pour
// que la file ne contienne que X (le prérequis) et Y (le dépendant).
const r2 = db.completeNode(claimedC.id, "w2", { hasBlockingReview: true });
check("complete avec blocage → state=review", r2.state === "review");
check("run_state passé à review", db.getNode(claimedC.id, { repoId: rid }).runState === "review");

const rev = db.createRepo({ slug: "rev-block" });
const rt = db.createNode(rev.id, null, { title: "Racine" });
const x = db.createNode(rev.id, rt.id, { title: "X" });
const y = db.createNode(rev.id, rt.id, { title: "Y" });
db.addNodeLink(y.id, x.id, { repoId: rev.id }); // Y dépend de X
const cx = db.claimNextNode(rev.id, "wx"); // seul X est débloqué
check("réclame X (Y bloqué)", cx && cx.id === x.id);
// repoId explicite : les ids numériques sont PAR base tracker (un même id existe
// dans plusieurs repos) → sans repoId, completeNode viserait le repo par défaut.
db.completeNode(x.id, "wx", { hasBlockingReview: true }, rev.id); // X part EN REVIEW (pas done)
const cy = db.claimNextNode(rev.id, "wy");
check("dépendant d'un nœud EN REVIEW non débloqué", cy === null);

console.log(`\n${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
