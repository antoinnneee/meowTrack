// Test NODE-343 : concurrence du chat PAR SESSION (granularité de file + reprise).
// La concurrence des VERROUS (aiLocks par session) spawne le CLI claude (non testable
// ici) ; on valide le CŒUR DÉTERMINISTE qui la sous-tend côté données :
//   - nextQueuedNodeTurn / nextQueuedForestTurn filtrent PAR SESSION (deux sessions
//     ont des files indépendantes — vider l'une ne touche pas l'autre)
//   - listQueuedNodeTurns renvoie les paires (nœud, session) en file → reprise au boot
//   - listQueuedForestSessions renvoie les sessions de forêt en file
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire (trackers sous .trackers/).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-conc-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const {
  createRepo, createNode,
  addNodeMessage, updateNodeMessage, nextQueuedNodeTurn, listQueuedNodeTurns,
  addForestMessage, updateForestMessage, nextQueuedForestTurn, listQueuedForestSessions,
} = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

// Crée une paire user(complete) + assistant(queued) dans une session donnée.
function enqueueNode(nid, rid, sessionId, text) {
  const u = addNodeMessage(nid, { role: "user", author: "u", body: text, state: "complete", sessionId }, rid);
  const a = addNodeMessage(nid, { role: "assistant", author: "claude", model: "sonnet", body: "", state: "queued", sessionId }, rid);
  return { u, a };
}

try {
  const repo = createRepo({ slug: "t-conc", name: "Test concurrence", localPath: TMP });
  const rid = repo.id;
  const node = createNode(rid, null, { title: "Nœud" });

  // Deux sessions du MÊME nœud, chacune avec un tour en file.
  const s0 = enqueueNode(node.id, rid, 0, "défaut");
  const s5 = enqueueNode(node.id, rid, 5, "session cinq");

  // ── Files indépendantes par session ────────────────────────────────────────
  check("session 0 → sa propre tête (s0)", nextQueuedNodeTurn(node.id, rid, 0).assistant.id === s0.a.id);
  check("session 5 → sa propre tête (s5)", nextQueuedNodeTurn(node.id, rid, 5).assistant.id === s5.a.id);
  check("session 5 : user déclencheur de SA session", nextQueuedNodeTurn(node.id, rid, 5).user.id === s5.u.id);

  // Vider la session 0 ne touche pas la session 5 (parallélisme, pas file partagée).
  updateNodeMessage(s0.a.id, { state: "complete" }, rid);
  check("session 0 vidée → null", nextQueuedNodeTurn(node.id, rid, 0) === null);
  check("session 5 intacte après vidage de la 0", nextQueuedNodeTurn(node.id, rid, 5).assistant.id === s5.a.id);

  // ── Reprise au boot : paires (nœud, session) ───────────────────────────────
  // Remet un tour en file dans la session 0 → on doit retrouver (node,0) ET (node,5).
  enqueueNode(node.id, rid, 0, "encore défaut");
  const turns = listQueuedNodeTurns(rid);
  const keys = turns.map((t) => `${t.nodeId}:${t.sessionId}`).sort();
  check("listQueuedNodeTurns renvoie (node,0) et (node,5)", keys.join(",") === `${node.id}:0,${node.id}:5`);

  // ── Versant forêt : sessions en file ───────────────────────────────────────
  const fu0 = addForestMessage(rid, { role: "user", author: "u", body: "forêt 0", state: "complete", sessionId: 0 });
  const fa0 = addForestMessage(rid, { role: "assistant", author: "claude", body: "", state: "queued", sessionId: 0 });
  addForestMessage(rid, { role: "user", author: "u", body: "forêt 3", state: "complete", sessionId: 3 });
  const fa3 = addForestMessage(rid, { role: "assistant", author: "claude", body: "", state: "queued", sessionId: 3 });

  check("forêt session 0 → sa tête (fa0)", nextQueuedForestTurn(rid, 0).assistant.id === fa0.id && nextQueuedForestTurn(rid, 0).user.id === fu0.id);
  check("forêt session 3 → sa tête (fa3)", nextQueuedForestTurn(rid, 3).assistant.id === fa3.id);
  check("listQueuedForestSessions = [0,3]", listQueuedForestSessions(rid).slice().sort((a, b) => a - b).join(",") === "0,3");

  updateForestMessage(fa0.id, { state: "complete" }, rid);
  check("forêt : session 0 vidée → null, session 3 intacte", nextQueuedForestTurn(rid, 0) === null && nextQueuedForestTurn(rid, 3).assistant.id === fa3.id);
  check("listQueuedForestSessions = [3] après vidage de la 0", listQueuedForestSessions(rid).join(",") === "3");

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
