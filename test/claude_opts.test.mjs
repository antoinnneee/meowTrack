// Test NODE-346 : options de spawn du CLI Claude (claudeOpts) — correctif Windows.
// Sur win32, le CLI `claude` est un shim .cmd que spawn refuse sans shell:true (EINVAL
// = SPAWN_ERROR). claudeOpts doit donc poser shell:true UNIQUEMENT sur win32 (sûr car
// le prompt passe par stdin, cf. ai/claude.js) + windowsHide. cwd selon repoAccess.
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

process.env.MEOWTRACK_NO_LISTEN = "1";

const { claudeOpts, claudeToolArgs } = await import("../config.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const isWin = process.platform === "win32";
  const o = claudeOpts(false);
  check("shell suit la plateforme (true ⇔ win32)", o.shell === isWin);
  check("windowsHide activé", o.windowsHide === true);
  check("env transmis (sandbox sans token)", o.env && typeof o.env === "object");

  // cwd : hors accès repo → dossier temp ; accès repo + root → la racine du clone.
  check("repoAccess=false → cwd = tmpdir", claudeOpts(false).cwd === tmpdir());
  check("repoAccess=true + root → cwd = root", claudeOpts(true, "/un/chemin/clone").cwd === "/un/chemin/clone");
  check("repoAccess=true sans root → cwd = tmpdir", claudeOpts(true, null).cwd === tmpdir());

  // NODE-346 : --settings reçoit un CHEMIN de fichier (pas du JSON inline), sûr sous cmd.exe.
  const args = claudeToolArgs(true);
  const si = args.indexOf("--settings");
  const settingsVal = si >= 0 ? args[si + 1] : "";
  check("--settings présent quand repoAccess", si >= 0);
  check("--settings = chemin .json (pas de JSON inline)", settingsVal.endsWith(".json") && !settingsVal.startsWith("{"));
  check("le fichier de settings existe", existsSync(settingsVal));
  // repoAccess=false → aucun outil, donc pas de --settings.
  check("repoAccess=false → pas de --settings", !claudeToolArgs(false).includes("--settings"));

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
