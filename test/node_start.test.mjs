// Test du démarrage MANUEL d'un nœud (NODE-302, meowtrack_node_start → startNode) :
// - startNode pose run_state='running' + bail pour owner sur un nœud 'active'
// - n'exige PAS une feuille (un parent peut être démarré à la main)
// - refuse un nœud non 'active' (paused) et un node d'activation
// - refuse si déjà pris par un AUTRE worker au bail valide ; re-start par le même OK
// - completeNode remet run_state='done' et libère le bail
// Base isolée : MEOWTRACK_DB → fichier temporaire.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-start-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo, createNode, getNode, updateNode, startNode, completeNode, peekNextNode, claimNextNode } = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const repo = createRepo({ slug: "t-start", name: "Test start", localPath: TMP });
  const rid = repo.id;

  const parent = createNode(rid, null, { title: "Objectif" });
  const child = createNode(rid, parent.id, { title: "Sous-tâche" });

  // Démarrage manuel d'une feuille active.
  const started = startNode(child.id, "claude-code", {}, rid);
  check("run_state passe à running", started.runState === "running");
  check("bail posé pour owner", started.leaseOwner === "claude-code" && !!started.leaseUntil);

  // Un PARENT (non-feuille) peut aussi être démarré manuellement (contrairement à l'orchestrateur).
  const startedParent = startNode(parent.id, "claude-code", {}, rid);
  check("parent (non-feuille) démarrable à la main", startedParent.runState === "running");

  // Re-start par le MÊME owner : OK (idempotent côté propriété du bail).
  let threw = false;
  try { startNode(child.id, "claude-code", {}, rid); } catch { threw = true; }
  check("re-start par le même owner accepté", !threw);

  // Start par un AUTRE owner alors que le bail est valide : refusé.
  let blocked = false;
  try { startNode(child.id, "autre-worker", {}, rid); } catch (e) { blocked = e.code === "not_startable"; }
  check("start par un autre owner (bail valide) refusé", blocked);

  // Un nœud 'paused' n'est pas démarrable.
  const paused = createNode(rid, null, { title: "En pause", status: "paused" });
  let pausedBlocked = false;
  try { startNode(paused.id, "claude-code", {}, rid); } catch (e) { pausedBlocked = e.code === "not_startable"; }
  check("nœud non 'active' refusé", pausedBlocked);

  // Un node d'activation (porte) n'est jamais démarré.
  const gate = createNode(rid, null, { title: "Porte", kind: "activation" });
  let gateBlocked = false;
  try { startNode(gate.id, "claude-code", {}, rid); } catch (e) { gateBlocked = e.code === "not_startable"; }
  check("node d'activation refusé", gateBlocked);

  // Clôture : run_state revient à 'done', bail libéré.
  completeNode(child.id, "claude-code", { summary: "Implémentation faite", branch: "meow/X", testResult: "pass" }, rid);
  const done = getNode(child.id, { repoId: rid });
  check("complete remet run_state='done'", done.runState === "done");
  check("complete libère le bail", done.leaseOwner == null);

  // NODE-303 : un récap d'implémentation est versé en NOTE persistante (append).
  const recap = (done.notes || []).find((n) => /Compte-rendu/.test(n.title || ""));
  check("note de récap ajoutée à la clôture", !!recap);
  check("récap contient summary + méta", recap && /Implémentation faite/.test(recap.body) && /meow\/X/.test(recap.body) && /pass/.test(recap.body));

  // Clôture SANS summary → pas de note ajoutée (best-effort).
  const c2 = createNode(rid, null, { title: "Sans récap" });
  startNode(c2.id, "claude-code", {}, rid);
  completeNode(c2.id, "claude-code", {}, rid);
  const done2 = getNode(c2.id, { repoId: rid });
  check("aucune note si pas de summary", (done2.notes || []).length === 0);

  // NODE-310 : peekNextNode (lecture seule) — montre la prochaine feuille SANS la réclamer.
  const pr = createRepo({ slug: "t-peek", name: "Test peek", localPath: TMP });
  const prid = pr.id;
  const leaf = createNode(prid, null, { title: "Feuille prête" });
  const peeked = peekNextNode(prid, {});
  check("peek renvoie la feuille prête", peeked && peeked.id === leaf.id);
  check("peek ne mute PAS (run_state reste null)", getNode(leaf.id, { repoId: prid }).runState == null);
  // Après un claim réel, la feuille (running) n'est plus dispatchable → peek = null.
  claimNextNode(prid, "w1");
  check("peek = null après réclamation", peekNextNode(prid, {}) === null);

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
