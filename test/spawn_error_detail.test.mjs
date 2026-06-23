// Test NODE-345 : enrichissement du détail d'une erreur SPAWN_ERROR du CLI Claude.
// Avant, l'erreur ne portait que le code « SPAWN_ERROR » (aucune piste). spawnErrorDetail
// extrait les champs utiles de l'erreur système Node (code/syscall/path/errno/message) +
// le binaire visé, et annexe un éventuel tail stderr — en une ligne lisible/journalisable.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-spawn-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";
process.env.MEOWTRACK_CLAUDE_BIN = "claude-test-bin"; // binaire fictif → apparaît dans le détail

const { spawnErrorDetail } = await import("../ai/claude.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  // Erreur système typique d'un spawn échoué (ENOENT : binaire introuvable).
  const enoent = Object.assign(new Error("spawn claude-test-bin ENOENT"), {
    code: "ENOENT", syscall: "spawn claude-test-bin", path: "claude-test-bin", errno: -2,
  });
  const d = spawnErrorDetail(enoent);
  check("inclut le binaire visé", d.includes("bin=claude-test-bin"));
  check("inclut le code", d.includes("code=ENOENT"));
  check("inclut le syscall", d.includes("syscall=spawn claude-test-bin"));
  check("inclut le path", d.includes("path=claude-test-bin"));
  check("inclut l'errno", d.includes("errno=-2"));
  check("inclut le message système", d.includes("ENOENT"));

  // EACCES (permission refusée) — autre cause fréquente de SPAWN_ERROR (≠ ENOENT).
  const eacces = Object.assign(new Error("spawn EACCES"), { code: "EACCES", syscall: "spawn" });
  check("EACCES : code présent", spawnErrorDetail(eacces).includes("code=EACCES"));

  // Tail stderr annexé quand fourni.
  const withErr = spawnErrorDetail(eacces, "  boom sur stderr  ");
  check("annexe le tail stderr (trimé)", withErr.includes("stderr: boom sur stderr"));
  check("pas de bloc stderr quand vide", !spawnErrorDetail(eacces, "   ").includes("stderr:"));

  // Cause absente → au moins le binaire (jamais une chaîne vide opaque).
  check("cause nulle → au moins bin=", spawnErrorDetail(null) === "bin=claude-test-bin");

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
