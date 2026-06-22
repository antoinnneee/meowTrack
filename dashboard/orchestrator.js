// orchestrator.js — onglet « Orchestrateur » : configuration éditable (bail,
// retries, branche, commande de test, auto-revue) + file des points de revue
// (résolution manuelle ou auto-revue par le chat IA). Module découplé : il s'abonne
// à l'événement `meow:view` émis par vibes.js et ne touche pas au graphe.
//
// Vanilla JS, aucune dépendance. Tout passe par l'API REST (core.js → ?repo= injecté).

import { $, api, esc } from "./core.js";

// Spécification des champs de config (alignée sur db/registry.js : ORCH_SPEC).
const FIELDS = [
  { key: "leaseMs", label: "Durée du bail (ms)", type: "int" },
  { key: "maxAttempts", label: "Tentatives max", type: "int" },
  { key: "parallel", label: "Exécuteurs parallèles", type: "int" },
  { key: "branchPrefix", label: "Préfixe de branche", type: "str" },
  { key: "testCommand", label: "Commande de test (par repo)", type: "str" },
  { key: "autoApplyUpdates", label: "Auto-appliquer les màj non destructives", type: "bool" },
  { key: "autoReview", label: "Auto-revue sur point bloquant", type: "bool" },
  { key: "autoReviewModel", label: "Modèle d'auto-revue", type: "model" },
  { key: "autoReviewPrompt", label: "Prompt de politique d'auto-revue", type: "text" },
  { key: "autoCompact", label: "Auto-compact (hint de césure à la clôture)", type: "bool" },
];
const ORIGIN_LABEL = { env: "hérité de l'env", global: "défini globalement", repo: "défini pour ce repo", default: "défaut" };

let _cfg = null;

function fieldControl(f, cfg) {
  const v = cfg[f.key];
  const id = "orchf_" + f.key;
  if (f.type === "bool") return `<input type="checkbox" id="${id}" ${v ? "checked" : ""} />`;
  if (f.type === "text") return `<textarea id="${id}" rows="4" placeholder="(aucune politique)">${esc(v)}</textarea>`;
  if (f.type === "model") {
    const opts = ["sonnet", "opus", "haiku"].map((m) => `<option value="${m}" ${v === m ? "selected" : ""}>${m}</option>`).join("");
    return `<select id="${id}">${opts}</select>`;
  }
  const t = f.type === "int" ? "number" : "text";
  return `<input type="${t}" id="${id}" value="${esc(v)}" />`;
}

function renderConfig(cfg) {
  _cfg = cfg;
  const form = $("#orchCfgForm");
  if (!form) return;
  form.innerHTML = FIELDS.map((f) => {
    const origin = (cfg._origin && cfg._origin[f.key]) || "default";
    return `<label class="orch-field">
      <span class="orch-flabel">${esc(f.label)} <em class="orch-origin">(${ORIGIN_LABEL[origin] || origin})</em></span>
      ${fieldControl(f, cfg)}
    </label>`;
  }).join("");
}

// Lit le patch depuis le formulaire (toutes les clés ; le data layer filtre selon le scope).
function readPatch() {
  const patch = {};
  for (const f of FIELDS) {
    const el = $("#orchf_" + f.key);
    if (!el) continue;
    if (f.type === "bool") patch[f.key] = el.checked;
    else if (f.type === "int") patch[f.key] = Number(el.value);
    else patch[f.key] = el.value;
  }
  return patch;
}

async function loadConfig() {
  try {
    renderConfig(await api.get("/api/settings/orchestrator"));
  } catch (e) {
    $("#orchCfgMsg").textContent = "Erreur : " + e.message;
  }
}

async function saveConfig(scope) {
  const msg = $("#orchCfgMsg");
  msg.textContent = "…";
  try {
    const cfg = await api.send("PUT", "/api/settings/orchestrator", { scope, patch: readPatch() });
    renderConfig(cfg);
    msg.textContent = scope === "repo" ? "✅ enregistré (repo)" : "✅ enregistré (global)";
    setTimeout(() => (msg.textContent = ""), 2500);
  } catch (e) {
    msg.textContent = "Erreur : " + e.message;
  }
}

function reviewItem(r) {
  const sugg = Array.isArray(r.suggested) && r.suggested.length ? ` · ${r.suggested.length} action(s) proposée(s)` : "";
  const badge = r.blocking ? '<span class="orch-badge blocking">bloquant</span>' : "";
  const actions =
    r.state === "open"
      ? `<div class="orch-rev-actions">
           <button class="primary" data-act="approve" data-id="${r.id}" data-node="${r.nodeId}">Approuver</button>
           <button class="ghost" data-act="dismiss" data-id="${r.id}" data-node="${r.nodeId}">Rejeter</button>
           <button class="ghost" data-act="rework" data-id="${r.id}" data-node="${r.nodeId}">Retravailler</button>
           <button class="ghost" data-act="auto" data-id="${r.id}" data-node="${r.nodeId}" title="Auto-revue par le chat IA top-level">🤖 Auto-réviser</button>
         </div>`
      : "";
  return `<li class="orch-review state-${esc(r.state)}">
    <div class="orch-rev-head">
      <span class="orch-kind">${esc(r.kind)}</span> ${badge}
      <span class="orch-rev-node">nœud #${esc(r.nodeId)}</span>
      <span class="orch-rev-state">${esc(r.state)}</span>
    </div>
    <div class="orch-rev-msg">${esc(r.message)}${sugg}</div>
    ${actions}
  </li>`;
}

async function loadReviews() {
  const list = $("#orchReviewList");
  if (!list) return;
  const state = $("#orchRevState").value;
  try {
    const reviews = await api.get("/api/nodes/reviews" + (state ? "?state=" + encodeURIComponent(state) : ""));
    $("#orchSub").textContent = reviews.length ? `${reviews.length} point(s)` : "";
    list.innerHTML = reviews.length ? reviews.map(reviewItem).join("") : '<li class="orch-empty">Aucun point de revue.</li>';
  } catch (e) {
    list.innerHTML = `<li class="orch-empty">Erreur : ${esc(e.message)}</li>`;
  }
}

async function onReviewAction(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { act, id, node } = btn.dataset;
  btn.disabled = true;
  try {
    if (act === "auto") {
      await api.send("POST", `/api/nodes/${encodeURIComponent(node)}/reviews/auto`, { reviewIds: [Number(id)] });
    } else {
      const decision = act === "approve" ? "approve" : act === "rework" ? "rework" : "dismiss";
      await api.send("POST", `/api/nodes/${encodeURIComponent(node)}/reviews/${encodeURIComponent(id)}/resolve`, {
        decision,
        applyActions: decision === "approve",
      });
    }
    await loadReviews();
  } catch (err) {
    alert("Échec : " + err.message);
    btn.disabled = false;
  }
}

export function initOrchestrator() {
  // Affichage à l'entrée dans l'onglet (événement émis par switchView).
  document.addEventListener("meow:view", (e) => {
    if (e.detail === "orch") { loadConfig(); loadReviews(); }
  });
  const save = $("#orchCfgSave");
  const saveRepo = $("#orchCfgSaveRepo");
  const refresh = $("#orchRevRefresh");
  const revState = $("#orchRevState");
  const list = $("#orchReviewList");
  if (save) save.addEventListener("click", () => saveConfig("global"));
  if (saveRepo) saveRepo.addEventListener("click", () => saveConfig("repo"));
  if (refresh) refresh.addEventListener("click", loadReviews);
  if (revState) revState.addEventListener("change", loadReviews);
  if (list) list.addEventListener("click", onReviewAction);
}
