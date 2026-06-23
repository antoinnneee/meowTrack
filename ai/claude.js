// ai/claude.js — invocations du CLI `claude` (spawn ; le PROMPT passe par STDIN, jamais
// sur la ligne de commande). `shell:true` UNIQUEMENT sur Windows (shim .cmd, cf.
// config.js/claudeOpts) — sûr car aucune donnée arbitraire n'est en argv (NODE-346).
//
// Headless sans outil pour la réécriture de texte (description, message de commit)
// et streaming NDJSON (`--output-format stream-json`) pour le chat. Sandbox :
// cwd/outils selon le mode (lecture seule du repo si AI_REPO_ACCESS), env SANS
// token, kill SIGKILL partout. Le batcher coalesce les deltas en events SSE.

import { spawn } from "node:child_process";
import { CLAUDE_BIN, claudeToolArgs, claudeOpts, AI_REPO_ACCESS } from "../config.js";
import { stagedDiffFor } from "../repos.js";
import { resolveModel } from "./prompts.js";
import { broadcast } from "../sse.js";

// NODE-345 : décrit la CAUSE d'un échec de spawn du CLI (le simple code "SPAWN_ERROR"
// ne disait rien). Extrait les champs utiles de l'erreur système Node (code/syscall/
// path/errno/message) + le binaire visé, en une ligne lisible/journalisable. `extra`
// = complément optionnel (ex. tail stderr déjà capté). Exporté pour le test de régression.
export function spawnErrorDetail(cause, extra = "") {
  const parts = [`bin=${CLAUDE_BIN}`];
  if (cause) {
    if (cause.code) parts.push(`code=${cause.code}`);
    if (cause.syscall) parts.push(`syscall=${cause.syscall}`);
    if (cause.path) parts.push(`path=${cause.path}`);
    if (cause.errno != null) parts.push(`errno=${cause.errno}`);
    if (cause.message) parts.push(String(cause.message));
  }
  const s = parts.join(" ; ");
  return extra && extra.trim() ? `${s} ; stderr: ${extra.trim()}` : s;
}

// NODE-346 : écrit le prompt sur le STDIN du process `claude -p` (qui le lit) puis ferme.
// Évite de mettre la donnée arbitraire sur la ligne de commande (sûr avec shell:true sur
// Windows, pas de limite ARG_MAX). Best-effort : un EPIPE (process déjà mort) est ignoré.
function writePromptStdin(child, prompt) {
  if (!child || !child.stdin) return;
  child.stdin.on("error", () => { /* EPIPE : le process a fermé son stdin → ignoré */ });
  try {
    child.stdin.write(String(prompt == null ? "" : prompt));
    child.stdin.end();
  } catch {
    /* ignore */
  }
}

// Lance `claude -p` headless SANS aucun outil (raisonnement pur, cwd hors repo) —
// utilisé par « Améliorer la description » (réécriture de texte, pas besoin du repo).
// NODE-346 : prompt par STDIN (idem streaming) → fonctionne aussi avec shell:true sur
// Windows. Implémenté via spawn (execFile ne permet pas d'alimenter stdin).
async function runClaudeSandboxed(prompt, model = "sonnet") {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, ["-p", "--model", resolveModel(model), ...claudeToolArgs(false)], claudeOpts(false));
    } catch (e) {
      return reject(Object.assign(new Error("SPAWN_ERROR"), { code: "SPAWN_ERROR", cause: e, detail: spawnErrorDetail(e) }));
    }
    let out = "", err = "", outBytes = 0, settled = false;
    const fin = (fn, a) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch { /* ignore */ } fn(a); };
    const timer = setTimeout(() => fin(reject, Object.assign(new Error("AI_TIMEOUT"), { code: "AI_TIMEOUT" })), 120000);
    child.on("error", (e) =>
      fin(reject, Object.assign(new Error("SPAWN_ERROR"), { code: e.code === "ENOENT" ? "ENOENT" : "SPAWN_ERROR", cause: e, detail: spawnErrorDetail(e, err) }))
    );
    child.stdout.on("data", (c) => {
      outBytes += c.length;
      if (outBytes > 8 * 1024 * 1024) return fin(reject, Object.assign(new Error("AI_OVERFLOW"), { code: "AI_OVERFLOW" }));
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c) => { err = (err + c.toString("utf8")).slice(-4096); });
    child.on("close", (code) =>
      code === 0
        ? fin(resolve, String(out || ""))
        : fin(reject, Object.assign(new Error("AI_EXIT"), { code: "AI_EXIT", exitCode: code, stderr: err }))
    );
    writePromptStdin(child, prompt);
  });
}

// Réécrit une description via Claude en mode headless (sonnet), sandboxé.
export async function improveDescriptionWithClaude(title, description) {
  const base = String(description || "").trim();
  if (!base) throw new Error("Description vide");
  const prompt =
    "Tu améliores la description d'une entrée de suivi (bug/feature/tâche) d'un projet logiciel.\n" +
    "Réécris la description ci-dessous pour qu'elle soit claire, structurée et actionnable " +
    "(contexte, comportement attendu/observé, étapes de repro si pertinent). Reste concis.\n" +
    "Garde la langue d'origine (français). Conserve TELS QUELS les éventuels tokens @chemin/vers/fichier.\n" +
    "Réponds UNIQUEMENT avec la description améliorée, sans préambule, sans guillemets, sans bloc de code.\n\n" +
    `Titre : ${title || "(sans titre)"}\n\nDescription actuelle :\n${base}`;
  try {
    const out = (await runClaudeSandboxed(prompt, "sonnet")).trim();
    if (!out) throw new Error("Réponse vide de Claude");
    return out;
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`CLI Claude introuvable (${CLAUDE_BIN}). Installer/configurer MEOWTRACK_CLAUDE_BIN.`);
    throw new Error(e.stderr ? String(e.stderr).trim() : e.message || String(e));
  }
}

// Rédige un message de commit à partir du DIFF indexé (staged), via Claude headless
// SANS accès disque (le diff est passé dans le prompt — claudeToolArgs(false)).
export async function suggestCommitMessage(repoId) {
  const diff = stagedDiffFor(repoId);
  if (!diff || !diff.trim()) throw new Error("Rien n'est indexé (staged) à committer.");
  const prompt =
    "Tu rédiges un message de commit git à partir du diff INDEXÉ ci-dessous.\n" +
    "Format : une 1re ligne impérative ≤ 72 caractères (style Conventional Commits si pertinent : " +
    "feat:/fix:/refactor:/docs:/chore:…), puis si utile une ligne vide et un corps court en puces expliquant le POURQUOI.\n" +
    "Langue : français. Réponds UNIQUEMENT avec le message, sans préambule, sans guillemets, sans bloc de code.\n\n" +
    "DIFF INDEXÉ :\n" +
    diff;
  try {
    const out = (await runClaudeSandboxed(prompt, "sonnet")).trim();
    if (!out) throw new Error("Réponse vide de Claude");
    return out.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`CLI Claude introuvable (${CLAUDE_BIN}). Installer/configurer MEOWTRACK_CLAUDE_BIN.`);
    throw new Error(e.stderr ? String(e.stderr).trim() : e.message || String(e));
  }
}

// ── Streaming : spawn `claude -p --output-format stream-json` ────────────────
// Lit le NDJSON ligne-à-ligne ; sépare thinking_delta (réflexion), text_delta
// (réponse) et tool_use (activité = « ce qu'il fait ») via callbacks ; source de
// vérité finale = event {type:"result"}.result.
const AI_STREAM_TIMEOUT = 300000;
const AI_MAX_OUTPUT = 12 * 1024 * 1024;
const AI_MAX_LINE = 256 * 1024;

export function runClaudeStreaming(prompt, model, root, { onThinking, onText, onTool, onChild } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // NODE-346 : le PROMPT est passé par STDIN, PAS en argv (`claude -p` lit stdin).
      // → pas de quoting/limite ARG_MAX, et la ligne de commande reste sûre même avec
      // shell:true sur Windows (cf. claudeOpts), où le shim .cmd l'exige.
      child = spawn(
        CLAUDE_BIN,
        ["-p", "--model", resolveModel(model), "--output-format", "stream-json", "--include-partial-messages", "--verbose", ...claudeToolArgs(AI_REPO_ACCESS)],
        claudeOpts(AI_REPO_ACCESS, root)
      );
    } catch (e) {
      return reject(Object.assign(new Error("SPAWN_ERROR"), { code: "SPAWN_ERROR", cause: e, detail: spawnErrorDetail(e) }));
    }
    if (onChild) onChild(child);
    writePromptStdin(child, prompt);

    let settled = false;
    let buf = "";
    let outBytes = 0;
    let resultText = "";
    let stderrTail = "";
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      fn(arg);
    };
    const timer = setTimeout(() => done(reject, Object.assign(new Error("AI_TIMEOUT"), { code: "AI_TIMEOUT" })), AI_STREAM_TIMEOUT);

    const handleEvent = (e) => {
      if (!e || typeof e !== "object") return;
      if (e.type === "stream_event" && e.event) {
        const ev = e.event;
        if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "thinking_delta" && ev.delta.thinking) onThinking && onThinking(ev.delta.thinking);
          else if (ev.delta.type === "text_delta" && ev.delta.text) onText && onText(ev.delta.text);
        } else if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "tool_use") {
          // Activité agentique (lecture de fichiers…) → surfacée comme « ce qu'il fait ».
          const cb = ev.content_block;
          const target = cb.input && (cb.input.file_path || cb.input.path || cb.input.pattern || cb.input.query);
          onTool && onTool(cb.name || "outil", target ? String(target).slice(0, 200) : "");
        }
      } else if (e.type === "result") {
        if (e.is_error) {
          done(reject, Object.assign(new Error("AI_RESULT_ERROR"), { code: "AI_RESULT_ERROR", detail: e.result || "" }));
          return;
        }
        if (typeof e.result === "string") resultText = e.result;
      }
    };

    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > AI_MAX_OUTPUT) return done(reject, Object.assign(new Error("AI_OVERFLOW"), { code: "AI_OVERFLOW" }));
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          /* ligne NDJSON malformée → ignorée (fail-soft) */
        }
      }
      if (buf.length > AI_MAX_LINE) return done(reject, Object.assign(new Error("AI_OVERFLOW"), { code: "AI_OVERFLOW" }));
    });
    // Drainer stderr (sinon --verbose peut bloquer le pipe), garder le tail.
    child.stderr.on("data", (c) => {
      stderrTail = (stderrTail + c.toString("utf8")).slice(-4096);
    });
    child.on("error", (e) =>
      done(reject, Object.assign(new Error("SPAWN_ERROR"), {
        code: e.code === "ENOENT" ? "ENOENT" : "SPAWN_ERROR",
        cause: e,
        detail: spawnErrorDetail(e, stderrTail),
      }))
    );
    child.on("close", (code) => {
      if (settled) return;
      // reliquat sans \n final
      if (buf.trim()) {
        try {
          handleEvent(JSON.parse(buf));
        } catch {
          /* ignore */
        }
      }
      if (resultText) return done(resolve, resultText);
      if (code === 0) return done(resolve, "");
      done(reject, Object.assign(new Error("AI_EXIT"), { code: "AI_EXIT", exitCode: code, stderr: stderrTail }));
    });
  });
}

// Coalesce les deltas (par kind) → un seul `ai:stream` toutes les ~80ms / 256 chars.
// `room` = canal SSE cible (`node:<id>` pour un nœud, `forest:<repoId>` pour le chat
// « top level ») ; le pipeline de streaming est indépendant du scope.
export function makeStreamBatcher(room, turnId) {
  const pending = { thinking: "", text: "" };
  let status = null; // dernier libellé d'action en cours (remplacé, jamais concaténé)
  let timer = null;
  const flush = () => {
    timer = null;
    for (const kind of ["thinking", "text"]) {
      if (pending[kind]) {
        broadcast(room, "ai:stream", { turnId, kind, delta: pending[kind] });
        pending[kind] = "";
      }
    }
    if (status !== null) {
      // émis après le texte du même flush → l'ordre d'affichage reste cohérent
      broadcast(room, "ai:stream", { turnId, kind: "status", text: status });
      status = null;
    }
  };
  const push = (kind, delta) => {
    if (kind === "status") {
      status = delta; // remplace : seul le dernier libellé compte
      if (!timer) timer = setTimeout(flush, 80);
      return;
    }
    pending[kind] += delta;
    if (pending[kind].length >= 256) flush();
    else if (!timer) timer = setTimeout(flush, 80);
  };
  return { push, end: () => { if (timer) clearTimeout(timer); flush(); } };
}
