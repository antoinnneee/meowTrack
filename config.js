// config.js — configuration d'instance (env) + politique de sandbox des features IA.
//
// Module FEUILLE (lit process.env ; aucune dépendance applicative). `dotenv/config`
// est chargé par le point d'entrée (server.js) AVANT ce module, donc l'env est prêt
// à l'évaluation. Les chemins liés au disque du serveur (PUBLIC/STATIC) vivent dans
// http-util.js (résolus depuis la racine du dépôt).

import { tmpdir } from "node:os";

export const PORT = Number(process.env.MEOWTRACK_PORT) || 7702;
// Défaut localhost (dev). En déploiement, MEOWTRACK_HOST=0.0.0.0 pour être
// joignable sur le réseau du serveur (pas de reverse-proxy).
export const HOST = process.env.MEOWTRACK_HOST || "127.0.0.1";
// Token d'accès à l'API. S'il est défini, toute requête /api/* doit présenter
// `Authorization: Bearer <token>` (ou en-tête `X-Meowtrack-Token`). Vide = ouvert
// (OK en local). Génér. : node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
export const TOKEN = (process.env.MEOWTRACK_TOKEN || "").trim();
// Binaire CLI Claude pour les features IA (claude -p). Doit être installé +
// authentifié sur la machine du serveur. Configurable.
export const CLAUDE_BIN = (process.env.MEOWTRACK_CLAUDE_BIN || "claude").trim();
// Repo (slug/id) appliqué par l'endpoint MCP quand un appel n'en précise pas.
export const MCP_DEFAULT_REPO = (process.env.MEOWTRACK_DEFAULT_REPO || "").trim();

// client_id d'une OAuth App GitHub (Device Flow activé) pour le bouton « Se connecter
// à GitHub ». Le client_id n'est PAS un secret (pas de client_secret en device flow).
// Créer : github.com/settings/developers → New OAuth App → cocher « Enable Device Flow ».
export const GITHUB_CLIENT_ID_ENV = (process.env.MEOWTRACK_GITHUB_CLIENT_ID || "").trim();

// Env minimal pour toute invocation IA : JAMAIS le MEOWTRACK_TOKEN ni secret du
// service (PATH/HOME/USERPROFILE seulement — HOME requis pour l'auth du CLI).
export const AI_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

// Accès LECTURE du repo par le chat des nœuds (défaut ON ; MEOWTRACK_AI_REPO_ACCESS=0
// pour verrouiller). Permet de discuter du code réel. Reste protégé : lecture seule
// (Read/Glob/Grep), AUCUNE écriture/shell/réseau, fichiers sensibles en deny.
export const AI_REPO_ACCESS = (process.env.MEOWTRACK_AI_REPO_ACCESS || "1").trim() !== "0";

// Refuse la LECTURE des fichiers sensibles même quand l'accès repo est ouvert
// (secrets, clés, bases, .git). deny > allow dans le modèle de permissions Claude.
const AI_DENY_SETTINGS = JSON.stringify({
  permissions: {
    deny: [
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(**/*.env)",
      "Read(**/.deployEnv)",
      "Read(**/*.pem)",
      "Read(**/*.key)",
      "Read(**/id_rsa*)",
      "Read(**/id_ed25519*)",
      "Read(**/secrets/**)",
      "Read(**/credentials*)",
      "Read(**/*.db)",
      "Read(**/*.db-*)",
      "Read(**/.git/**)",
    ],
  },
});

// Args d'outils selon le mode. repoAccess=false → AUCUN outil (raisonnement pur).
// repoAccess=true → lecture seule (Read/Glob/Grep) + écriture/shell/réseau interdits
// (deny gagne) + secrets en deny via --settings.
export function claudeToolArgs(repoAccess) {
  if (!repoAccess)
    return ["--disallowedTools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit", "Task"];
  return [
    "--allowedTools", "Read", "Glob", "Grep",
    "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "NotebookEdit", "Task",
    "--settings", AI_DENY_SETTINGS,
  ];
}
// cwd = racine du clone du repo concerné si accès ouvert (pour Read/Glob/Grep),
// sinon dossier temp. `root` = clone du repo du nœud (multi-repos).
export function claudeOpts(repoAccess, root) {
  return { cwd: repoAccess && root ? root : tmpdir(), env: AI_ENV };
}
