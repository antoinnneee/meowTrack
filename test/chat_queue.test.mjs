// Test NODE-329 : file PERSISTÉE des tours de chat IA (Option B).
// La logique de chaînage spawne le CLI claude (non disponible en test) ; on valide
// donc le CŒUR DÉTERMINISTE de la file (persistance + sélection FIFO + reprise) :
//   - l'état de message `queued` est accepté et persisté (non rabattu sur `complete`)
//   - nextQueuedNodeTurn / nextQueuedForestTurn renvoient la paire {assistant,user} la
//     plus ANCIENNE, réhydratée depuis le user qui précède le placeholder
//   - le FIFO avance quand le placeholder en tête passe à `complete`
//   - le scope par SESSION est respecté (un queued de session N s'apparie au user de N)
//   - listQueuedNodeIds / hasQueuedForestTurn alimentent la reprise au boot
//   - failDangling*Turns repasse les placeholders pending/streaming orphelins en `error`
// Base isolée : MEOWTRACK_DB pointe vers un fichier temporaire (trackers sous .trackers/).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-queue-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const {
  createRepo,
  createNode,
  addNodeMessage,
  updateNodeMessage,
  getNodeMessage,
  nextQueuedNodeTurn,
  listQueuedNodeIds,
  failDanglingNodeTurns,
  addForestMessage,
  updateForestMessage,
  getForestMessage,
  nextQueuedForestTurn,
  hasQueuedForestTurn,
  failDanglingForestTurns,
} = await import("../db.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const repo = createRepo({ slug: "t-queue", name: "Test file", localPath: TMP });
  const rid = repo.id;
  const node = createNode(rid, null, { title: "Nœud chat" });

  // ── 1) L'état `queued` est accepté tel quel (non coercé) ───────────────────
  const u1 = addNodeMessage(node.id, { role: "user", author: "alice", body: "premier", state: "complete" }, rid);
  const a1 = addNodeMessage(node.id, { role: "assistant", author: "claude", model: "sonnet", body: "", state: "queued" }, rid);
  check("placeholder persisté en état 'queued'", getNodeMessage(a1.id, rid).state === "queued");

  // ── 2) nextQueuedNodeTurn renvoie la paire {assistant,user} réhydratée ─────
  let turn = nextQueuedNodeTurn(node.id, rid);
  check("file nœud : assistant en tête = a1", turn && turn.assistant.id === a1.id);
  check("file nœud : user déclencheur réhydraté = u1", turn && turn.user && turn.user.id === u1.id && turn.user.body === "premier");
  check("file nœud : modèle du placeholder conservé", turn && turn.assistant.model === "sonnet");

  // ── 3) FIFO : un 2e tour en file ne passe pas devant le 1er ────────────────
  const u2 = addNodeMessage(node.id, { role: "user", author: "bob", body: "second", state: "complete" }, rid);
  const a2 = addNodeMessage(node.id, { role: "assistant", author: "claude", model: "opus", body: "", state: "queued" }, rid);
  turn = nextQueuedNodeTurn(node.id, rid);
  check("FIFO : a1 reste en tête malgré a2", turn && turn.assistant.id === a1.id);

  // Le 1er tour se termine → la tête avance vers a2 / u2.
  updateNodeMessage(a1.id, { state: "complete", body: "ok" }, rid);
  turn = nextQueuedNodeTurn(node.id, rid);
  check("FIFO : a2 devient la tête après complétion de a1", turn && turn.assistant.id === a2.id);
  check("FIFO : u2 est le user de a2 (pas u1)", turn && turn.user.id === u2.id && turn.user.body === "second");

  // ── 4) Scope par session ───────────────────────────────────────────────────
  const uS = addNodeMessage(node.id, { role: "user", author: "carl", body: "en session 7", state: "complete", sessionId: 7 }, rid);
  const aS = addNodeMessage(node.id, { role: "assistant", author: "claude", model: "haiku", body: "", state: "queued", sessionId: 7 }, rid);
  // a2 (session 0) reste la tête globale par id ; on vérifie l'appariement de aS via session.
  updateNodeMessage(a2.id, { state: "complete" }, rid);
  turn = nextQueuedNodeTurn(node.id, rid);
  check("session : aS apparié au user de SA session (uS)", turn && turn.assistant.id === aS.id && turn.user.id === uS.id);

  // ── 5) listQueuedNodeIds (reprise boot) ────────────────────────────────────
  check("listQueuedNodeIds repère le nœud en file", listQueuedNodeIds(rid).includes(node.id));
  updateNodeMessage(aS.id, { state: "complete" }, rid);
  check("listQueuedNodeIds vide quand plus rien en file", !listQueuedNodeIds(rid).includes(node.id));
  check("nextQueuedNodeTurn → null quand file vide", nextQueuedNodeTurn(node.id, rid) === null);

  // ── 6) failDanglingNodeTurns : pending/streaming orphelins → error ─────────
  const dPend = addNodeMessage(node.id, { role: "assistant", author: "claude", body: "", state: "pending" }, rid);
  const dStream = addNodeMessage(node.id, { role: "assistant", author: "claude", body: "partiel", state: "streaming" }, rid);
  const changed = failDanglingNodeTurns(rid);
  check("failDanglingNodeTurns touche les 2 orphelins", changed === 2);
  check("orphelin pending vide → error + message de reprise", getNodeMessage(dPend.id, rid).state === "error" && /redémarrage/.test(getNodeMessage(dPend.id, rid).body));
  check("orphelin streaming → error en gardant le corps", getNodeMessage(dStream.id, rid).state === "error" && getNodeMessage(dStream.id, rid).body === "partiel");

  // ── 7) Versant forêt ───────────────────────────────────────────────────────
  const fu = addForestMessage(rid, { role: "user", author: "alice", body: "forêt q", state: "complete" });
  const fa = addForestMessage(rid, { role: "assistant", author: "claude", model: "opus", body: "", state: "queued" });
  check("hasQueuedForestTurn vrai quand un tour forêt est en file", hasQueuedForestTurn(rid) === true);
  let fturn = nextQueuedForestTurn(rid);
  check("file forêt : paire {assistant,user} correcte", fturn && fturn.assistant.id === fa.id && fturn.user.id === fu.id);
  updateForestMessage(fa.id, { state: "complete" }, rid);
  check("hasQueuedForestTurn faux après complétion", hasQueuedForestTurn(rid) === false);

  const fp = addForestMessage(rid, { role: "assistant", author: "claude", body: "", state: "streaming" });
  check("failDanglingForestTurns repasse l'orphelin en error", failDanglingForestTurns(rid) === 1 && getForestMessage(fp.id, rid).state === "error");

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
