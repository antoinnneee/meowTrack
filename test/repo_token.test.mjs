// Test NODE-372 : token PAR dépôt (remplace le token global partagé pour MCP/skills).
// Couvre : le modèle (génération + repoByToken + rotation + sérialiseur gardé) et la
// validation serveur (resolveAuth admin vs token de dépôt + enforceRepoScope qui
// scope un token de dépôt à SON seul dépôt et épingle ?repo=).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "meowtrack-token-"));
process.env.MEOWTRACK_DB = join(TMP, "meowtrack.db");
process.env.MEOWTRACK_NO_LISTEN = "1";
process.env.MEOWTRACK_TOKEN = "ADMIN-GLOBAL-TOKEN"; // active la garde token (mode admin global)

const { createRepo, getRepo, repoByToken, rotateRepoToken, genRepoToken } = await import("../db.js");
const { resolveAuth, enforceRepoScope } = await import("../server.js");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

// Construit un faux req porteur d'un Bearer + une query.
const reqWith = (tok) => ({ headers: tok ? { authorization: "Bearer " + tok } : {} });
const Q = (s = "") => new URLSearchParams(s);

try {
  const a = createRepo({ slug: "a", name: "A", localPath: join(TMP, "a") });
  const b = createRepo({ slug: "b", name: "B", localPath: join(TMP, "b") });

  // ── Modèle ─────────────────────────────────────────────────────────────────
  check("token généré à la création (48 hex)", /^[0-9a-f]{48}$/.test(a.token == null ? getRepo("a", true).token : a.token));
  const tokA = getRepo("a", true).token;
  const tokB = getRepo("b", true).token;
  check("tokens distincts par dépôt", tokA && tokB && tokA !== tokB);
  check("repoByToken résout le bon dépôt", repoByToken(tokA)?.id === a.id);
  check("repoByToken(token inconnu) → null", repoByToken("nope") === null);
  check("sérialiseur masque le token par défaut", getRepo("a").token === undefined);
  check("sérialiseur expose le token si demandé", getRepo("a", true).token === tokA);
  check("genRepoToken() renvoie 48 hex", /^[0-9a-f]{48}$/.test(genRepoToken()));

  // Rotation : nouveau token, ancien invalidé.
  const rotated = rotateRepoToken("a");
  check("rotation change le token", rotated.token && rotated.token !== tokA);
  check("rotation : ancien token ne résout plus", repoByToken(tokA) === null);
  check("rotation : nouveau token résout", repoByToken(rotated.token)?.id === a.id);
  const tokA2 = rotated.token;

  // ── resolveAuth ───────────────────────────────────────────────────────────
  check("token admin global → admin", (() => { const r = resolveAuth(reqWith("ADMIN-GLOBAL-TOKEN"), Q()); return r.ok && r.admin; })());
  check("token de dépôt → scopé (non admin)", (() => { const r = resolveAuth(reqWith(tokA2), Q()); return r.ok && !r.admin && r.repoId === a.id; })());
  check("token inconnu (avec token global exigé) → refusé", resolveAuth(reqWith("bidon"), Q()).ok === false);
  check("aucun token (avec token global exigé) → refusé", resolveAuth(reqWith(null), Q()).ok === false);
  check("?token= en query accepté aussi", (() => { const r = resolveAuth({ headers: {} }, Q("token=" + tokB)); return r.ok && r.repoId === b.id; })());

  // ── enforceRepoScope (token de dépôt A) ─────────────────────────────────────
  const authA = { ok: true, admin: false, repoId: a.id };
  const authAdmin = { ok: true, admin: true };

  check("admin : tout autorisé", enforceRepoScope("/api/repos", "POST", Q(), authAdmin) === true);

  // Route scopée sans repo → autorisée + ?repo= épinglé au dépôt du token.
  const q1 = Q();
  check("route scopée sans repo → autorisée", enforceRepoScope("/api/nodes/NODE-1", "GET", q1, authA) === true);
  check("route scopée : ?repo= épinglé au dépôt du token", q1.get("repo") === String(a.id));

  // ?repo= divergent → rejeté.
  check("?repo= divergent (autre dépôt) → refusé", enforceRepoScope("/api/issues", "GET", Q("repo=b"), authA) === false);
  // ?repo= = son propre dépôt → autorisé.
  check("?repo= = son dépôt → autorisé", enforceRepoScope("/api/issues", "GET", Q("repo=a"), authA) === true);

  // Gestion du registre : création / import / suppression = admin only.
  check("POST /api/repos (créer) → refusé pour token de dépôt", enforceRepoScope("/api/repos", "POST", Q(), authA) === false);
  check("POST /api/repos/import → refusé", enforceRepoScope("/api/repos/import", "POST", Q(), authA) === false);
  check("GET /api/repos (liste) → autorisé (filtré en aval)", enforceRepoScope("/api/repos", "GET", Q(), authA) === true);
  check("GET /api/repos/resolve → autorisé", enforceRepoScope("/api/repos/resolve", "GET", Q(), authA) === true);

  // /api/repos/:id — son propre dépôt vs un autre.
  check("GET /api/repos/a (son dépôt) → autorisé", enforceRepoScope("/api/repos/a", "GET", Q(), authA) === true);
  check("GET /api/repos/b (autre dépôt) → refusé", enforceRepoScope("/api/repos/b", "GET", Q(), authA) === false);
  check("POST /api/repos/a/token/rotate (son dépôt) → autorisé", enforceRepoScope("/api/repos/a/token/rotate", "POST", Q(), authA) === true);
  check("DELETE /api/repos/a (supprimer son dépôt) → refusé (admin)", enforceRepoScope("/api/repos/a", "DELETE", Q(), authA) === false);

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
