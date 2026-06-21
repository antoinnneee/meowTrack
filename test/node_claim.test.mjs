// Test de la réclamation de tâches (orchestrateur) : claimNextNode ne rend que des
// feuilles actives débloquées, l'exclusivité tient, le bail expire/se renouvelle,
// maxAttempts est respecté, et un nœud en revue n'est jamais réclamé.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "meow-claim-"));
process.env.MEOWTRACK_DB = join(dir, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";
console.error = () => {}; // silence les logs createNode

const db = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

const repo = db.listRepos()[0];
const rid = repo.id;
const root = db.createNode(rid, null, { title: "Racine" });
const a = db.createNode(rid, root.id, { title: "A" });
const b = db.createNode(rid, root.id, { title: "B" });
db.addNodeLink(b.id, a.id, { repoId: rid }); // B dépend de A

// 1. claim rend une feuille débloquée (A), jamais B (prérequis non done).
const c1 = db.claimNextNode(rid, "w1");
check("claim rend A (feuille débloquée)", c1 && c1.id === a.id);
check("claim pose le bail (running + owner)", c1 && c1.runState === "running" && c1.leaseOwner === "w1");

// 2. exclusivité + B bloqué : un 2e worker n'obtient rien (A leasé, B bloqué).
const c2 = db.claimNextNode(rid, "w2");
check("B non réclamable tant que A pas done", c2 === null);

// 3. complete A → B débloqué et réclamable.
db.completeNode(a.id, "w1", { summary: "ok" });
const c3 = db.claimNextNode(rid, "w2");
check("après done de A, B réclamable", c3 && c3.id === b.id);

// 4. un nœud en revue (run_state='review') n'est jamais réclamé.
const cc = db.createNode(rid, root.id, { title: "C" });
const cl = db.claimNextNode(rid, "w3");
check("réclame C", cl && cl.id === cc.id);
db.completeNode(cl.id, "w3", { hasBlockingReview: true });
const afterReview = db.claimNextNode(rid, "w4");
check("nœud en review jamais réclamé (plus rien de prêt)", afterReview === null);

// 5. maxAttempts respecté.
const d = db.createNode(rid, root.id, { title: "D" });
const f1 = db.claimNextNode(rid, "w5", { maxAttempts: 2 });
check("claim D (tentative 1)", f1 && f1.id === d.id);
db.failNode(d.id, "w5", { error: "x" });
const f2 = db.claimNextNode(rid, "w5", { maxAttempts: 2 });
check("reclaim D après échec (tentative 2)", f2 && f2.id === d.id);
db.failNode(d.id, "w5", { error: "x" });
const f3 = db.claimNextNode(rid, "w5", { maxAttempts: 2 });
check("maxAttempts atteint → plus réclamable", f3 === null);

// 6. bail expiré reréclamable + renewLease (repo isolé pour éviter les interférences).
const r2 = db.createRepo({ slug: "r2-expiry" });
const rt2 = db.createNode(r2.id, null, { title: "R2" });
const e = db.createNode(r2.id, rt2.id, { title: "E" });
const e1 = db.claimNextNode(r2.id, "wx", { leaseMs: 1000 });
check("claim E (repo2)", e1 && e1.id === e.id);
check("bail actif → non réclamable", db.claimNextNode(r2.id, "wy", { leaseMs: 1000 }) === null);
check("renewLease par le détenteur → true", db.renewLease(e.id, "wx", 1000, r2.id) === true);
check("renewLease par un autre → false", db.renewLease(e.id, "intrus", 1000, r2.id) === false);
await new Promise((r) => setTimeout(r, 1200));
const e3 = db.claimNextNode(r2.id, "wy", { leaseMs: 1000 });
check("bail expiré → reréclamable par un autre", e3 && e3.id === e.id && e3.leaseOwner === "wy");

console.log(`\n${pass} OK, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
