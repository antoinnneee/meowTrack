// Test NODE-301 (v2) : résolution cwd → dépôt pour le verrou mono-repo SANS config.
// resolveRepoByPath(fsPath) matche un chemin contre la racine de chaque dépôt
// (containment), match le plus spécifique gagnant, null si aucun.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-resolve-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";

const { createRepo } = await import("../db.js");
const { resolveRepoByPath } = await import("../repos.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  const rootA = join(TMP, "repoA");
  const rootB = join(TMP, "repoB");
  const rootNested = join(rootA, "nested"); // sous-dossier de A → match plus spécifique
  createRepo({ slug: "a", name: "A", localPath: rootA });
  createRepo({ slug: "b", name: "B", localPath: rootB });
  createRepo({ slug: "nested", name: "Nested", localPath: rootNested });

  check("racine exacte → repo", resolveRepoByPath(rootA)?.slug === "a");
  check("sous-dossier → repo contenant", resolveRepoByPath(join(rootA, "src", "deep"))?.slug === "a");
  check("autre repo", resolveRepoByPath(rootB)?.slug === "b");
  check("match le plus spécifique (racine la plus longue)", resolveRepoByPath(join(rootNested, "x"))?.slug === "nested");
  check("chemin hors de tout dépôt → null", resolveRepoByPath(join(TMP, "ailleurs")) === null);
  check("chemin vide → null", resolveRepoByPath("") === null);
  check("renvoie aussi la racine résolue", resolveRepoByPath(rootB)?.root === resolve(rootB));

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
