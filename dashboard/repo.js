// repo.js — bloc « Gestionnaire de dépôts (git) » : toolbar + sidebar branches,
// graphe d'historique (façon GitKraken), staging/commit, config git, auth GitHub
// (device flow) et credentials. Exporte les ponts openRepoView / initRepo.

import { $, esc, api, getToken, injectRepo } from "./core.js";
import { toast, showCtxMenu, renderMarkdown } from "./vibes.js";

// ── Modales génériques (remplacent window.prompt/confirm/alert — cohérence UX) ──
// Construites en DOM à la volée (aucun HTML à prévoir), refermées au clic backdrop /
// Échap. uiPrompt/uiConfirm renvoient une Promise ; uiAlert est fire-and-forget.
function _btn(cls, label) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  return b;
}
function _modalShell(title) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal ui-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  if (title) {
    const h = document.createElement("h2");
    h.textContent = title;
    modal.appendChild(h);
  }
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  return { backdrop, modal, close };
}
function uiPrompt(title, { label = "", value = "", placeholder = "", multiline = false, okLabel = "Valider" } = {}) {
  return new Promise((resolve) => {
    const { modal, close } = _modalShell(title);
    const field = document.createElement("label");
    field.className = "ui-field";
    if (label) field.append(document.createTextNode(label));
    const input = document.createElement(multiline ? "textarea" : "input");
    if (!multiline) input.type = "text";
    if (multiline) input.rows = 4;
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    field.appendChild(input);
    modal.appendChild(field);
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = _btn("ghost", "Annuler");
    const okb = _btn("primary", okLabel);
    actions.append(cancel, okb);
    modal.appendChild(actions);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      close();
      resolve(v);
    };
    cancel.onclick = () => done(null);
    okb.onclick = () => done(input.value);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !multiline) {
        e.preventDefault();
        done(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      }
    });
    setTimeout(() => {
      input.focus();
      if (input.select) input.select();
    }, 0);
  });
}
function uiConfirm(message, { danger = false, okLabel = "Confirmer" } = {}) {
  return new Promise((resolve) => {
    const { modal, close } = _modalShell("Confirmation");
    const p = document.createElement("p");
    p.className = "ui-msg";
    p.textContent = message;
    modal.appendChild(p);
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = _btn("ghost", "Annuler");
    const okb = _btn(danger ? "danger" : "primary", okLabel);
    actions.append(cancel, okb);
    modal.appendChild(actions);
    const done = (v) => {
      close();
      resolve(v);
    };
    cancel.onclick = () => done(false);
    okb.onclick = () => done(true);
    setTimeout(() => okb.focus(), 0);
  });
}
function uiAlert(message) {
  const { modal, close } = _modalShell("");
  const p = document.createElement("p");
  p.className = "ui-msg";
  p.textContent = message;
  modal.appendChild(p);
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const okb = _btn("primary", "OK");
  actions.appendChild(okb);
  modal.appendChild(actions);
  okb.onclick = close;
  setTimeout(() => okb.focus(), 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Gestionnaire de repos (git) — toolbar + sidebar branches + graphe d'historique
// (façon GitKraken) + staging par fichier + commit (message rédigé par claude -p) +
// menus contextuels (branches : merge/rename/delete ; commits : tag/branche/cherry-
// pick/revert/reset) + page de configuration git. Réutilise $/esc/api/showCtxMenu.
// ═══════════════════════════════════════════════════════════════════════════

const LANE_COLORS = ["#7c5cff", "#4dd4ac", "#5a8dee", "#ff9f43", "#ff6b6b", "#e056fd", "#22d3ee", "#f6c945", "#a0d911", "#ff7eb6"];
const laneColor = (k) => LANE_COLORS[((k % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];

const repoMgr = { status: null, log: null, branches: null, stashes: [], loading: false };

// ── Cycle de vie ──────────────────────────────────────────────────────────────
export async function openRepoView() {
  connectRepoStream();
  await loadRepoAll();
}
async function refreshRepo() {
  await loadRepoAll();
}
async function loadRepoAll() {
  if (repoMgr.loading) return;
  repoMgr.loading = true;
  try {
    const [st, log, br, stashes] = await Promise.all([
      api.get("/api/git/status").catch((e) => ({ ok: false, output: e.message, files: [] })),
      api.get("/api/git/log?limit=300").catch(() => ({ commits: [], head: null })),
      api.get("/api/git/branches").catch(() => ({ current: null, local: [], remote: [] })),
      api.get("/api/git/stashes").catch(() => []),
    ]);
    repoMgr.status = st;
    repoMgr.log = log;
    repoMgr.branches = br;
    repoMgr.stashes = Array.isArray(stashes) ? stashes : [];
    renderRepoToolbar();
    renderConflictBanner();
    renderRepoSide();
    renderRepoGraph();
    renderWorkingTree();
  } finally {
    repoMgr.loading = false;
  }
}

// ── Bandeau d'opération en cours (merge/cherry-pick/revert/rebase conflictuel) ──
const OP_LABEL = { merge: "Fusion", "cherry-pick": "Cherry-pick", revert: "Revert", rebase: "Rebase" };
function renderConflictBanner() {
  const banner = $("#repoConflict");
  if (!banner) return;
  const op = (repoMgr.status && repoMgr.status.op && repoMgr.status.op.type) || null;
  if (!op) {
    banner.hidden = true;
    return;
  }
  const conflicts = ((repoMgr.status && repoMgr.status.files) || []).filter((f) => f.conflicted).length;
  $("#repoConflictMsg").textContent =
    `${OP_LABEL[op] || op} en cours` + (conflicts ? ` — ${conflicts} fichier(s) en conflit à résoudre puis indexer` : " — prêt à continuer");
  $("#rgContinue").disabled = conflicts > 0;
  banner.hidden = false;
}

// Pull intelligent : ff-only d'abord ; si l'intégration échoue alors qu'on a divergé
// (local ET distant ont avancé), propose un pull --rebase.
async function pullSmart() {
  try {
    const r = await api.send("POST", "/api/git/pull", {});
    await refreshRepo();
    if (r && r.ok === false) {
      if (/diverg|non-fast-forward|not possible to fast-forward|ff.?only/i.test(r.output || "")) {
        if (await uiConfirm("Le ff-only a échoué (branches divergentes).\n\nTenter un pull --rebase ?", { okLabel: "Rebase" }))
          await doGit(() => api.send("POST", "/api/git/pull", { rebase: true }));
      } else {
        uiAlert("Échec du pull :\n" + (r.output || "erreur inconnue"));
      }
    }
  } catch (e) {
    uiAlert(e.message === "git_busy" ? "Une opération git est déjà en cours sur ce repo." : "Erreur : " + e.message);
    await refreshRepo();
  }
}

// ── Temps réel : abonnement SSE (auto-refresh + multi-onglets). Géré paresseusement :
// un seul flux par vue, réouvert à chaque entrée, débounce du rafraîchissement.
let repoStream = null;
let repoStreamTimer = null;
function connectRepoStream() {
  disconnectRepoStream();
  let url = injectRepo("/api/git/stream");
  const tok = getToken();
  if (tok) url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok);
  try {
    repoStream = new EventSource(url);
    repoStream.addEventListener("git:changed", () => {
      if (repoStreamTimer) return; // débounce : un refresh par fenêtre
      repoStreamTimer = setTimeout(() => {
        repoStreamTimer = null;
        if (!$("#repoView").hidden) loadRepoAll();
      }, 400);
    });
  } catch {
    /* EventSource indisponible : on garde le bouton ↻ */
  }
}
function disconnectRepoStream() {
  if (repoStream) {
    try {
      repoStream.close();
    } catch {
      /* ignore */
    }
    repoStream = null;
  }
  if (repoStreamTimer) {
    clearTimeout(repoStreamTimer);
    repoStreamTimer = null;
  }
}

// Exécute une opération git mutante, signale l'échec/les conflits, rafraîchit.
async function doGit(call, { confirmMsg } = {}) {
  if (confirmMsg && !(await uiConfirm(confirmMsg, { danger: true }))) return null;
  try {
    const r = await call();
    if (r && r.ok === false) uiAlert("Échec git :\n" + (r.output || "erreur inconnue"));
    else if (r && typeof r.output === "string" && /CONFLICT|conflit|Merge conflict/i.test(r.output)) uiAlert(r.output);
    await refreshRepo();
    return r;
  } catch (e) {
    uiAlert(e.message === "git_busy" ? "Une opération git est déjà en cours sur ce repo." : "Erreur : " + e.message);
    await refreshRepo();
    return null;
  }
}

// ── Toolbar ─────────────────────────────────────────────────────────────────
function renderRepoToolbar() {
  const st = repoMgr.status || {};
  $("#repoBranch").textContent = st.detached ? "(HEAD détaché)" : st.branch || "—";
  const trk = $("#repoTrack");
  if (st.upstream) trk.textContent = `↑${st.ahead || 0} ↓${st.behind || 0} · ${st.upstream}`;
  else trk.textContent = st.branch ? "(pas d'upstream — Push créera le suivi)" : "";
  const setCnt = (id, n) => {
    const el = $(id);
    el.textContent = n > 0 ? n : "";
    el.hidden = !(n > 0);
  };
  setCnt("#rgPullCnt", st.behind || 0);
  setCnt("#rgPushCnt", st.ahead || 0);
  // Cohérence d'activation : Pop seulement s'il y a une remise ; Stash seulement s'il
  // y a des modifications à remiser (symétrie avec les compteurs Pull/Push et Commit).
  $("#rgStashPop").disabled = !repoMgr.stashes.length;
  $("#rgStash").disabled = !((st.files || []).length > 0);
}

// ── Sidebar branches / remotes / stashes ──────────────────────────────────────
function renderRepoSide() {
  const br = repoMgr.branches || { local: [], remote: [] };
  const item = (cls, name, attrs, right) =>
    `<div class="side-item ${cls}" ${attrs}><span class="si-name" title="${esc(name)}">${esc(name)}</span>${right || ""}</div>`;
  let html = "";

  // Pastille « masquée » (œil barré) ; les branches masquées sont grisées et
  // restent listées ici pour pouvoir les ré-afficher (clic droit).
  const hiddenBadge = (b) => (b.hidden ? `<span class="si-hidden" title="${b.hiddenLocked ? "Branche de suivi — masquée par défaut" : "Masquée des sélecteurs"}">🚫</span>` : "");

  html += `<div class="side-group"><h4>Local <span class="hint">(clic droit : options)</span></h4>`;
  if (!br.local.length) html += `<div class="side-empty">—</div>`;
  for (const b of br.local) {
    const trk = b.ahead || b.behind ? `<span class="si-track">↑${b.ahead} ↓${b.behind}</span>` : "";
    const cls = `${b.current ? "current local" : "local"}${b.hidden ? " hidden" : ""}`;
    html += item(cls, b.name, `data-branch="${esc(b.name)}"`, hiddenBadge(b) + trk);
  }
  html += `</div>`;

  html += `<div class="side-group"><h4>Distant</h4>`;
  if (!br.remote.length) html += `<div class="side-empty">—</div>`;
  for (const b of br.remote) {
    const short = b.name.includes("/") ? b.name.slice(b.name.indexOf("/") + 1) : b.name;
    const cls = `remote${b.hidden ? " hidden" : ""}`;
    html += item(cls, b.name, `data-checkout-remote="${esc(short)}" data-remote-full="${esc(b.name)}"`, hiddenBadge(b));
  }
  html += `</div>`;

  html += `<div class="side-group"><h4>Remises (stash) <span class="hint">(clic droit : options)</span></h4>`;
  if (!repoMgr.stashes.length) html += `<div class="side-empty">—</div>`;
  for (const s of repoMgr.stashes) html += item("stash", `${s.ref} · ${s.desc}`, `data-stash-ref="${esc(s.ref)}"`, "");
  html += `</div>`;

  $("#repoSide").innerHTML = html;
}

// Masque / ré-affiche une branche dans les sélecteurs (sans toucher le dépôt git).
async function setBranchHidden(name, hidden) {
  try {
    await api.send("POST", hidden ? "/api/git/branch/hide" : "/api/git/branch/unhide", { name });
  } catch (e) {
    uiAlert("Erreur : " + e.message);
  }
  await refreshRepo();
}
// Entrée de menu « Masquer / Afficher » selon l'état courant (null si non proposable).
function hideMenuItem(b) {
  if (!b || b.hiddenLocked) return null; // branche de suivi : toujours masquée
  return b.hidden
    ? { label: "Afficher dans les sélecteurs", onClick: () => setBranchHidden(b.name, false) }
    : { label: "Masquer des sélecteurs", onClick: () => setBranchHidden(b.name, true) };
}

// Menu contextuel d'une branche locale (clic droit) : checkout, merge, rename, masquer, delete.
function branchCtxMenu(name, clientX, clientY) {
  const current = repoMgr.branches && repoMgr.branches.current;
  const bObj = (repoMgr.branches && repoMgr.branches.local || []).find((x) => x.name === name);
  const items = [];
  if (name !== current) {
    items.push({ label: `Checkout « ${name} »`, onClick: () => doGit(() => api.send("POST", "/api/git/checkout", { name })) });
    items.push({
      label: `Merge « ${name} » dans « ${current || "?"} »`,
      onClick: () => doGit(() => api.send("POST", "/api/git/merge", { name }), { confirmMsg: `Fusionner « ${name} » dans « ${current} » ?` }),
    });
  }
  items.push({
    label: "Renommer…",
    onClick: async () => {
      const newName = ((await uiPrompt("Renommer la branche", { label: "Nouveau nom :", value: name })) || "").trim();
      if (newName && newName !== name) doGit(() => api.send("POST", "/api/git/branch/rename", { oldName: name, newName }));
    },
  });
  if (name !== current) {
    items.push({
      label: `Rebaser « ${current || "?"} » sur « ${name} »`,
      onClick: () => doGit(() => api.send("POST", "/api/git/rebase", { onto: name }), { confirmMsg: `Rebaser la branche courante « ${current} » sur « ${name} » ?` }),
    });
  }
  const hide = hideMenuItem(bObj);
  if (hide) items.push(hide);
  if (name !== current) items.push({ label: "Supprimer la branche locale", danger: true, onClick: () => doGitDeleteBranch(name) });
  showCtxMenu(clientX, clientY, items);
}

// Menu contextuel d'une branche distante (clic droit) : checkout (suivi local),
// merge dans la branche courante, suppression côté distant (git push --delete).
function remoteBranchCtxMenu(fullName, shortName, clientX, clientY) {
  const current = repoMgr.branches && repoMgr.branches.current;
  const slash = fullName.indexOf("/");
  const remote = slash > 0 ? fullName.slice(0, slash) : "origin";
  const branch = slash > 0 ? fullName.slice(slash + 1) : fullName;
  const bObj = (repoMgr.branches && repoMgr.branches.remote || []).find((x) => x.name === fullName);
  const hide = hideMenuItem(bObj && { ...bObj, name: shortName }); // masquage par nom court
  const items = [
    { label: `Checkout « ${shortName} » (suivi local)`, onClick: () => doGit(() => api.send("POST", "/api/git/checkout", { name: shortName })) },
    {
      label: `Merge « ${fullName} » dans « ${current || "?"} »`,
      onClick: () => doGit(() => api.send("POST", "/api/git/merge", { name: fullName }), { confirmMsg: `Fusionner « ${fullName} » dans « ${current} » ?` }),
    },
    ...(hide ? [hide] : []),
    {
      label: "Supprimer la branche distante",
      danger: true,
      onClick: () =>
        doGit(() => api.send("POST", "/api/git/branch/delete-remote", { remote, branch }), {
          confirmMsg: `⚠️ Supprimer la branche distante « ${fullName} » ?\n\ngit push ${remote} --delete ${branch}\n\nAction irréversible côté serveur distant.`,
        }),
    },
  ];
  showCtxMenu(clientX, clientY, items);
}

// Menu contextuel d'une remise (clic droit) : voir le diff, appliquer (garde), pop
// (retire), jeter. `pop`/`apply`/`drop` ciblent la réf exacte (stash@{N}).
function stashCtxMenu(ref, clientX, clientY) {
  showCtxMenu(clientX, clientY, [
    { label: "Voir le diff", onClick: () => openStashDiff(ref) },
    { label: "Appliquer (garder la remise)", onClick: () => doGit(() => api.send("POST", "/api/git/stash/apply", { ref }), { confirmMsg: `Appliquer ${ref} (sans la retirer) ?` }) },
    { label: "Pop (appliquer puis retirer)", onClick: () => doGit(() => api.send("POST", "/api/git/stash/pop", { ref }), { confirmMsg: `Restaurer puis retirer ${ref} ?` }) },
    { label: "Jeter la remise", danger: true, onClick: () => doGit(() => api.send("POST", "/api/git/stash/drop", { ref }), { confirmMsg: `⚠️ Jeter ${ref} ? (irréversible)` }) },
  ]);
}
async function openStashDiff(ref) {
  try {
    const r = await api.get(`/api/git/stash/show?ref=${encodeURIComponent(ref)}`);
    openDiffModal(`Remise ${ref}`, "", renderDiffText(r.diff));
  } catch (e) {
    uiAlert("Erreur : " + e.message);
  }
}

// ── Graphe d'historique : calcul des lanes + rendu SVG par ligne ──────────────
function computeLanes(commits, headHash) {
  let lanes = [];
  const rows = [];
  for (const c of commits) {
    const incoming = lanes.slice();
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) {
        col = lanes.length;
        lanes.push(null);
      }
    }
    const parentLanes = [];
    if (c.parents.length === 0) {
      lanes[col] = null;
    } else {
      // Libère la colonne du commit : on la réattribuera (peut-être) au 1er parent.
      lanes[col] = null;
      for (let p = 0; p < c.parents.length; p++) {
        const ph = c.parents[p];
        let pk = lanes.indexOf(ph); // une lane porte-t-elle DÉJÀ ce parent ? → dédup
        if (pk === -1) {
          if (p === 0 && lanes[col] == null) pk = col;
          else {
            pk = lanes.indexOf(null);
            if (pk === -1) {
              pk = lanes.length;
              lanes.push(null);
            }
          }
          lanes[pk] = ph;
        }
        if (!parentLanes.includes(pk)) parentLanes.push(pk);
      }
    }
    // Toute AUTRE lane qui attendait c (enfants placés avant dédup, ordre par date) se
    // termine au nœud. Avec la dédup ci-dessus, c'est normalement déjà une seule lane.
    for (let k = 0; k < lanes.length; k++) if (k !== col && incoming[k] === c.hash) lanes[k] = null;
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ commit: c, col, incoming, outgoing: lanes.slice(), parentLanes, isHead: c.hash === headHash });
  }
  // maxLanes inclut col+1 : un tip dont l'unique parent est déjà sur une lane se place
  // sur sa propre colonne puis elle est libérée/élaguée — le nœud doit rester dans le SVG.
  let maxLanes = 1;
  for (const r of rows) maxLanes = Math.max(maxLanes, r.incoming.length, r.outgoing.length, r.col + 1);
  return { rows, maxLanes };
}

function svgRow(row, maxLanes) {
  const W = 18,
    H = 34,
    R = 4.2,
    mid = H / 2;
  const x = (k) => W / 2 + k * W;
  const width = maxLanes * W;
  const out = [];
  const vline = (xx, y1, y2, color) => `<line x1="${xx}" y1="${y1}" x2="${xx}" y2="${y2}" stroke="${color}" stroke-width="2"/>`;
  const curve = (x1, y1, x2, y2, color) =>
    `<path d="M${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}" stroke="${color}" stroke-width="2" fill="none"/>`;
  for (let k = 0; k < row.incoming.length; k++) {
    const h = row.incoming[k];
    if (!h) continue;
    const color = laneColor(k);
    if (h === row.commit.hash) out.push(k === row.col ? vline(x(k), 0, mid, color) : curve(x(k), 0, x(row.col), mid, color));
    else out.push(vline(x(k), 0, mid, color));
  }
  for (let k = 0; k < row.outgoing.length; k++) {
    const h = row.outgoing[k];
    if (!h) continue;
    const color = laneColor(k);
    if (row.incoming[k] === h && row.incoming[k] !== row.commit.hash) out.push(vline(x(k), mid, H, color));
    if (row.parentLanes.includes(k)) out.push(k === row.col ? vline(x(k), mid, H, color) : curve(x(row.col), mid, x(k), H, color));
  }
  const nc = laneColor(row.col);
  out.push(`<circle cx="${x(row.col)}" cy="${mid}" r="${R}" fill="${nc}" stroke="var(--bg)" stroke-width="1.5"/>`);
  if (row.isHead) out.push(`<circle cx="${x(row.col)}" cy="${mid}" r="${R + 3}" fill="none" stroke="${nc}" stroke-width="1.5"/>`);
  return `<svg width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${out.join("")}</svg>`;
}

function avatarInitials(name) {
  const p = String(name || "?").trim().split(/\s+/);
  return (((p[0] && p[0][0]) || "") + ((p[1] && p[1][0]) || "")).toUpperCase() || "?";
}
function avatarColor(email) {
  let h = 0;
  const s = String(email || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 52% 46%)`;
}

function renderRepoGraph() {
  const log = repoMgr.log || { commits: [], head: null };
  const pane = $("#repoGraph");
  if (!log.commits.length) {
    pane.innerHTML = `<div class="empty">${repoMgr.status && repoMgr.status.ok === false ? esc(repoMgr.status.output || "Pas un dépôt git.") : "Aucun commit."}</div>`;
    return;
  }
  const { rows, maxLanes } = computeLanes(log.commits, log.head);
  const pill = (r) => `<span class="ref-pill ${r.head ? "head" : r.kind}">${esc(r.name)}</span>`;
  pane.innerHTML = rows
    .map((row) => {
      const c = row.commit;
      const refs = (c.refs || []).map(pill).join("");
      return `<div class="commit-row ${row.isHead ? "head" : ""}" data-hash="${esc(c.hash)}">
        <div class="commit-graph-cell">${svgRow(row, maxLanes)}</div>
        <div class="commit-msg">${refs}<span class="subject">${esc(c.subject)}</span></div>
        <div class="commit-author"><span class="avatar" style="background:${avatarColor(c.email)}">${esc(avatarInitials(c.author))}</span>${esc(c.author)}</div>
        <div class="commit-date" title="${esc(c.dateIso)}">${esc(c.date)}</div>
      </div>`;
    })
    .join("");
}

// Menu contextuel d'un commit (clic droit) : tag, branche ici, checkout, cherry-pick…
function commitCtxMenu(hash, clientX, clientY) {
  const short = (hash || "").slice(0, 8);
  showCtxMenu(clientX, clientY, [
    {
      label: "Créer un tag ici…",
      onClick: async () => {
        const name = ((await uiPrompt("Créer un tag", { label: "Nom du tag :", placeholder: "v1.0.0" })) || "").trim();
        if (!name) return;
        const message = ((await uiPrompt("Message du tag", { label: "Message (vide = tag léger) :" })) || "").trim();
        doGit(() => api.send("POST", "/api/git/tag", { name, ref: hash, message }));
      },
    },
    {
      label: "Créer une branche ici…",
      onClick: async () => {
        const name = ((await uiPrompt("Nouvelle branche", { label: "Nom (créée sur ce commit) :" })) || "").trim();
        if (name) doGit(() => api.send("POST", "/api/git/branch", { name, ref: hash, checkout: true }));
      },
    },
    { label: "Checkout ce commit (HEAD détaché)", onClick: () => doGit(() => api.send("POST", "/api/git/checkout-commit", { hash }), { confirmMsg: `Checkout ${short} en HEAD détaché ?` }) },
    { label: "Cherry-pick sur la branche courante", onClick: () => doGit(() => api.send("POST", "/api/git/cherry-pick", { hash }), { confirmMsg: `Cherry-pick ${short} sur la branche courante ?` }) },
    { label: "Revert ce commit", onClick: () => doGit(() => api.send("POST", "/api/git/revert", { hash }), { confirmMsg: `Créer un commit qui annule ${short} ?` }) },
    { label: "Comparer avec HEAD (diff)", onClick: () => openRefsDiff(hash, "HEAD") },
    { label: "Réinitialiser la branche ici (--mixed)", onClick: () => doGit(() => api.send("POST", "/api/git/reset", { hash, mode: "mixed" }), { confirmMsg: `Déplacer la branche courante sur ${short} (--mixed, garde les modifs) ?` }) },
    { label: "Réinitialiser la branche ici (--hard)", danger: true, onClick: () => doGit(() => api.send("POST", "/api/git/reset", { hash, mode: "hard" }), { confirmMsg: `⚠️ reset --hard sur ${short} : TOUTES les modifications non commitées seront PERDUES. Continuer ?` }) },
    { label: "Copier le hash", onClick: () => { try { navigator.clipboard.writeText(hash); } catch { /* ignore */ } } },
    { label: "Voir le détail", onClick: () => openCommitDetail(hash) },
  ]);
}

// ── Working tree : fichiers non indexés / indexés + commit ────────────────────
const ST_LETTER = { M: "M", A: "A", D: "D", R: "R", C: "C", U: "U", T: "T" };
function fileRow(f, section) {
  const isStaged = section === "staged";
  const isConflict = section === "conflict";
  const code = isStaged ? f.x : f.untracked ? "?" : f.y;
  const letter = isConflict ? "!" : f.untracked ? "?" : ST_LETTER[code] || code || "•";
  const stCls = isConflict ? "conflict" : f.untracked ? "untracked" : ST_LETTER[code] ? code : "";
  const title = isConflict ? "conflit" : f.untracked ? "non suivi" : { M: "modifié", A: "ajouté", D: "supprimé", R: "renommé" }[code] || "modifié";
  let act;
  if (isConflict) act = `<button class="act stage" data-act="stage" title="Marquer résolu (indexer)">✓</button>`;
  else if (isStaged) act = `<button class="act unstage" data-act="unstage" title="Désindexer">−</button>`;
  else
    act = `<button class="act discard" data-act="discard" title="Abandonner les modifications">↶</button><button class="act stage" data-act="stage" title="Indexer">＋</button>`;
  return `<li class="wc-file${isConflict ? " conflict-file" : ""}" data-path="${esc(f.path)}" data-staged="${isStaged}" data-untracked="${f.untracked}">
    <span class="st ${stCls}" title="${title}">${esc(letter)}</span>
    <span class="fp" title="${esc(f.path)}"><bdi>${esc(f.path)}</bdi></span>
    ${act}
  </li>`;
}
function renderWorkingTree() {
  const st = repoMgr.status || { files: [] };
  const files = st.files || [];
  // Les fichiers en conflit (UU/AA/DD…) apparaîtraient à la fois en indexé ET non
  // indexé : on les isole en tête des « non indexées » avec une action « Marquer résolu ».
  const conflicted = files.filter((f) => f.conflicted);
  const unstaged = files.filter((f) => f.unstaged && !f.conflicted);
  const staged = files.filter((f) => f.staged && !f.conflicted);
  const unstagedHtml = conflicted.map((f) => fileRow(f, "conflict")).join("") + unstaged.map((f) => fileRow(f, "unstaged")).join("");
  $("#wcUnstaged").innerHTML = unstagedHtml || `<li class="empty">Rien à indexer.</li>`;
  $("#wcStaged").innerHTML = staged.length ? staged.map((f) => fileRow(f, "staged")).join("") : `<li class="empty">Rien d'indexé.</li>`;
  $("#wcUnstagedCount").textContent = conflicted.length + unstaged.length;
  $("#wcStagedCount").textContent = staged.length;
  updateCommitBtn();
}
function updateCommitBtn() {
  const staged = ((repoMgr.status && repoMgr.status.files) || []).filter((f) => f.staged && !f.conflicted).length;
  const msg = $("#wcCommitMsg").value.trim();
  // En mode amender, on peut committer sans fichier indexé (ré-écrire le message seul)
  // et sans message (--no-edit garde l'existant). Sinon : au moins un fichier + un message.
  const amend = $("#wcAmend") && $("#wcAmend").checked;
  $("#wcCommitBtn").disabled = amend ? !(staged > 0 || msg) : !(staged > 0 && msg);
  $("#wcCommitBtn").textContent = amend ? "Amender" : "Commit";
}

// ── Diff (fichier ou commit) ──────────────────────────────────────────────────
function renderDiffText(text) {
  if (!text) return '<span class="dl-meta">(aucune différence)</span>';
  return esc(text)
    .split("\n")
    .map((l) => {
      let cls = "";
      if (l.startsWith("+++") || l.startsWith("---")) cls = "dl-meta";
      else if (l.startsWith("@@")) cls = "dl-hunk";
      else if (l.startsWith("+")) cls = "dl-add";
      else if (l.startsWith("-")) cls = "dl-del";
      else if (/^(diff |index |new file|deleted file|rename |similarity |old mode|new mode)/.test(l)) cls = "dl-meta";
      return `<span class="${cls}">${l || " "}</span>`;
    })
    .join("\n");
}
function openDiffModal(title, metaHtml, bodyHtml) {
  $("#diffTitle").textContent = title;
  const meta = $("#diffMeta");
  meta.innerHTML = metaHtml || "";
  meta.hidden = !metaHtml;
  $("#diffBody").innerHTML = bodyHtml;
  $("#diffBackdrop").hidden = false;
}
function closeDiffModal() {
  $("#diffBackdrop").hidden = true;
  currentFileDiff = null;
}

// Une ligne de diff en bloc (indépendant des espaces du <pre> : on concatène en "").
function diffLineSpan(l) {
  let cls = "";
  if (l.startsWith("+++") || l.startsWith("---")) cls = "dl-meta";
  else if (l.startsWith("@@")) cls = "dl-hunk";
  else if (l.startsWith("+")) cls = "dl-add";
  else if (l.startsWith("-")) cls = "dl-del";
  else if (/^(diff |index |new file|deleted file|rename |similarity |old mode|new mode)/.test(l)) cls = "dl-meta";
  return `<span class="dl-line ${cls}">${esc(l) || " "}</span>`;
}

// Découpe un diff unifié en en-tête (avant le 1er @@) + hunks → staging partiel.
function parseDiffHunks(text) {
  const header = [];
  const hunks = [];
  let cur = null;
  let started = false;
  for (const l of String(text || "").split("\n")) {
    if (l.startsWith("@@")) {
      started = true;
      if (cur) hunks.push(cur);
      cur = { lines: [l] };
    } else if (!started) {
      header.push(l);
    } else if (cur) {
      cur.lines.push(l);
    }
  }
  if (cur) hunks.push(cur);
  return { header: header.join("\n"), hunks };
}

// Diff état courant (pour le staging par hunk + blame).
let currentFileDiff = null;

// Rend le diff d'un fichier suivi avec un bouton d'action PAR hunk (indexer / désindexer
// / abandonner). Les hunks d'un fichier non suivi n'ont pas de sens → renderDiffText.
function renderHunkDiff() {
  const { hunks, staged, untracked } = currentFileDiff;
  if (untracked) return renderDiffText(currentFileDiff.raw);
  if (!hunks.length) return '<span class="dl-meta">(aucune différence)</span>';
  const parts = [];
  for (let i = 0; i < hunks.length; i++) {
    const bar = staged
      ? `<button class="ghost xs" data-hunk="${i}" data-mode="unstage">− Désindexer ce hunk</button>`
      : `<button class="ghost xs" data-hunk="${i}" data-mode="stage">＋ Indexer ce hunk</button><button class="danger xs" data-hunk="${i}" data-mode="discard">↶ Abandonner</button>`;
    const body = hunks[i].lines.map(diffLineSpan).join("");
    parts.push(`<div class="diff-hunk"><div class="diff-hunk-bar">${bar}</div>${body}</div>`);
  }
  return parts.join("");
}

async function openFileDiff(path, staged, untracked) {
  try {
    const r = await api.get(`/api/git/diff?path=${encodeURIComponent(path)}&staged=${staged}&untracked=${untracked}`);
    const parsed = parseDiffHunks(r.diff);
    currentFileDiff = { path, staged, untracked, raw: r.diff || "", header: parsed.header, hunks: parsed.hunks };
    const blameBtn = untracked ? "" : `<button class="ghost xs" id="diffBlameBtn">🔍 Blame</button>`;
    openDiffModal(path + (staged ? "  (indexé)" : ""), blameBtn, renderHunkDiff());
  } catch (e) {
    uiAlert("Erreur diff : " + e.message);
  }
}

// Applique un hunk précis (indexer / désindexer / abandonner) via /api/git/apply-patch,
// puis rouvre le diff pour montrer ce qu'il reste.
async function applyHunk(index, mode) {
  if (!currentFileDiff || !currentFileDiff.hunks[index]) return;
  const patch = currentFileDiff.header + "\n" + currentFileDiff.hunks[index].lines.join("\n") + "\n";
  const opts = mode === "stage" ? { cached: true } : mode === "unstage" ? { cached: true, reverse: true } : { reverse: true };
  if (mode === "discard" && !(await uiConfirm("Abandonner ce hunk dans le working tree ? (irréversible)", { danger: true }))) return;
  const { path, staged, untracked } = currentFileDiff;
  const r = await doGit(() => api.send("POST", "/api/git/apply-patch", { patch, ...opts }));
  if (r && r.ok !== false) openFileDiff(path, staged, untracked); // rouvre le diff mis à jour
}

// Blame d'un fichier (qui a écrit chaque ligne).
async function openBlame(path, branch = null) {
  try {
    const r = await api.get(`/api/git/blame?path=${encodeURIComponent(path)}${branch ? "&branch=" + encodeURIComponent(branch) : ""}`);
    if (r.ok === false) return uiAlert(r.output || "blame indisponible");
    const rows = (r.lines || [])
      .map((ln) => `<span class="dl-line"><span class="blame-sha" title="${esc(ln.author)}">${esc(ln.short)}</span> <span class="blame-author">${esc(ln.author)}</span>  ${esc(ln.content) || " "}</span>`)
      .join("");
    openDiffModal("Blame · " + path, "", rows || '<span class="dl-meta">(vide)</span>');
  } catch (e) {
    uiAlert("Erreur blame : " + e.message);
  }
}

// Diff entre deux réfs (commit ↔ HEAD…).
async function openRefsDiff(a, b) {
  try {
    const r = await api.get(`/api/git/diff-refs?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    if (r.ok === false) return uiAlert(r.output || "diff indisponible");
    openDiffModal(`${(a || "").slice(0, 8)} → ${(b || "").slice(0, 8)}`, "", renderDiffText(r.diff));
  } catch (e) {
    uiAlert("Erreur : " + e.message);
  }
}

// Reflog : positions récentes de HEAD (filet de sécurité). Chaque entrée → menu (reset/checkout).
async function openReflog() {
  try {
    const r = await api.get("/api/git/reflog?limit=120");
    const rows = (r.entries || [])
      .map(
        (e) =>
          `<li class="reflog-row" data-hash="${esc(e.hash)}"><code>${esc(e.selector)}</code> <span class="rl-sub">${esc(e.subject)}</span> <span class="rl-date" title="${esc(e.dateIso)}">${esc(e.date)}</span></li>`
      )
      .join("");
    const { modal, close } = _modalShell("🕔 Reflog");
    const ul = document.createElement("ul");
    ul.className = "reflog-list";
    ul.innerHTML = rows || '<li class="empty">(vide)</li>';
    ul.addEventListener("contextmenu", (ev) => {
      const li = ev.target.closest(".reflog-row");
      if (!li) return;
      ev.preventDefault();
      const hash = li.dataset.hash;
      const short = hash.slice(0, 8);
      showCtxMenu(ev.clientX, ev.clientY, [
        { label: "Voir le détail", onClick: () => { close(); openCommitDetail(hash); } },
        { label: "Créer une branche ici…", onClick: async () => { const n = ((await uiPrompt("Nouvelle branche", { label: "Nom :" })) || "").trim(); if (n) { close(); doGit(() => api.send("POST", "/api/git/branch", { name: n, ref: hash, checkout: true })); } } },
        { label: "Checkout (HEAD détaché)", onClick: () => { close(); doGit(() => api.send("POST", "/api/git/checkout-commit", { hash }), { confirmMsg: `Checkout ${short} en HEAD détaché ?` }); } },
        { label: "Réinitialiser la branche ici (--hard)", danger: true, onClick: () => { close(); doGit(() => api.send("POST", "/api/git/reset", { hash, mode: "hard" }), { confirmMsg: `⚠️ reset --hard sur ${short} : modifications non commitées PERDUES. Continuer ?` }); } },
        { label: "Copier le hash", onClick: () => { try { navigator.clipboard.writeText(hash); } catch { /* ignore */ } } },
      ]);
    });
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Clic droit sur une entrée pour agir (retrouver un commit « perdu » après un reset/rebase).";
    modal.append(hint, ul);
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const okb = _btn("ghost", "Fermer");
    okb.onclick = close;
    actions.appendChild(okb);
    modal.appendChild(actions);
  } catch (e) {
    uiAlert("Erreur reflog : " + e.message);
  }
}
async function openCommitDetail(hash) {
  try {
    const d = await api.get("/api/git/commit/" + encodeURIComponent(hash));
    if (d.ok === false) return uiAlert(d.output || "commit introuvable");
    const meta = `${esc(d.author)} &lt;${esc(d.email)}&gt; · ${esc(d.date)} · <span style="font-family:ui-monospace,monospace">${esc((d.hash || "").slice(0, 10))}</span>`;
    const files = (d.files || [])
      .map((f) => `<span class="dl-meta">+${esc(f.added)} -${esc(f.deleted)}</span>  ${esc(f.path)}`)
      .join("\n");
    const body = (d.body ? esc(d.body) + "\n\n" : "") + (files || "(aucun fichier)");
    openDiffModal(d.subject || hash, meta, `<span>${body}</span>`);
  } catch (e) {
    uiAlert("Erreur : " + e.message);
  }
}

// ── Explorateur de fichiers (arbre + contenu colorisé via highlight.js) ────────
// kind: text | media | binary ; mode: read | edit | md | media
const filesState = { all: [], current: null, content: "", kind: null, mode: "read", dirty: false, isMd: false };

// Extension → famille de média (lecteur compatible). Le SVG est traité comme image
// (rendu direct) plutôt que comme XML éditable.
const MEDIA_KIND = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image", ico: "image", avif: "image",
  mp4: "video", m4v: "video", webm: "video", ogv: "video", mov: "video", mkv: "video",
  mp3: "audio", wav: "audio", ogg: "audio", oga: "audio", flac: "audio", m4a: "audio", aac: "audio",
};
function mediaKind(path) {
  const ext = path.toLowerCase().split(".").pop();
  return MEDIA_KIND[ext] || null;
}
// URL des octets bruts d'un média (auth par ?token= car <img>/<video> ne portent pas d'en-tête).
function rawUrl(path) {
  return injectRepo("/api/git/raw?path=" + encodeURIComponent(path)) + "&token=" + encodeURIComponent(getToken() || "");
}

// Extension → langage highlight.js (alias) pour les cas où le nom ne suffit pas.
// Repli sur l'auto-détection de hljs si l'extension est inconnue.
const EXT_LANG = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", php: "php", swift: "swift", scala: "scala", lua: "lua",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  xml: "xml", html: "xml", htm: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  md: "markdown", markdown: "markdown", sql: "sql", graphql: "graphql",
  dockerfile: "dockerfile", makefile: "makefile", diff: "diff", patch: "diff",
};
function langForPath(path) {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return EXT_LANG[ext] || null;
}

// Construit un arbre imbriqué { dirs:Map, files:[] } à partir d'une liste plate.
function buildFileTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ name: parts[parts.length - 1], path: f });
  }
  return root;
}
// Rendu récursif de l'arbre en HTML (esc partout). `open` force l'expansion (filtre).
function renderTreeNode(node, prefix, depth, open) {
  let html = "";
  for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dirPath = prefix ? prefix + "/" + name : name;
    const expanded = open || depth === 0;
    html += `<div class="ftree-dir${expanded ? " open" : ""}" data-dir="${esc(dirPath)}">`;
    html += `<div class="ftree-row ftree-dirrow"><span class="ftree-caret">▸</span><span class="ftree-label">${esc(name)}</span></div>`;
    html += `<div class="ftree-children"${expanded ? "" : " hidden"}>${renderTreeNode(child, dirPath, depth + 1, open)}</div>`;
    html += `</div>`;
  }
  for (const f of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
    html += `<div class="ftree-row ftree-file" data-file="${esc(f.path)}" title="${esc(f.path)}"><span class="ftree-label">${esc(f.name)}</span></div>`;
  }
  return html;
}
function renderFileTree(files, open) {
  const el = $("#filesTree");
  if (!files.length) {
    el.innerHTML = `<div class="empty">Aucun fichier.</div>`;
    return;
  }
  el.innerHTML = renderTreeNode(buildFileTree(files), "", 0, !!open);
  // Conserve la sélection courante visible après un re-rendu (filtre).
  if (filesState.current) {
    const sel = el.querySelector(`[data-file="${CSS.escape(filesState.current)}"]`);
    if (sel) sel.classList.add("active");
  }
}

async function openFilesModal() {
  $("#filesBackdrop").hidden = false;
  $("#filesTree").innerHTML = `<div class="empty">Chargement…</div>`;
  $("#filesFilter").value = "";
  // Réinitialise l'état + le panneau (revient en lecture, vide le contenu).
  filesState.current = null;
  filesState.content = "";
  filesState.kind = null;
  filesState.mode = "read";
  markFilesDirty(false);
  $("#filesPath").innerHTML = `<span class="hint">Sélectionne un fichier à gauche.</span>`;
  $("#filesCode").textContent = "";
  $("#filesGutter").textContent = "";
  setFilesPanel("read");
  refreshFilesToolbar();
  try {
    const tree = await api.get("/api/git/tree");
    filesState.all = tree.files || [];
    $("#filesBranch").textContent = tree.branch ? `⎇ ${tree.branch}${tree.commit ? " · " + tree.commit : ""}` : "";
    renderFileTree(filesState.all, false);
  } catch (e) {
    $("#filesTree").innerHTML = `<div class="empty">Erreur : ${esc(e.message)}</div>`;
  }
}
function closeFilesModal() {
  if (filesState.dirty && !confirm("Abandonner les modifications non enregistrées ?")) return;
  markFilesDirty(false);
  $("#filesBackdrop").hidden = true;
}
function filterFileTree() {
  const q = $("#filesFilter").value.trim().toLowerCase();
  if (!q) return renderFileTree(filesState.all, false);
  const matches = filesState.all.filter((f) => f.toLowerCase().includes(q));
  renderFileTree(matches, true);
}

// Affiche un seul des panneaux (lecture / édition / aperçu MD / média).
function setFilesPanel(name) {
  $("#filesScroll").hidden = name !== "read";
  $("#filesEditor").hidden = name !== "edit";
  $("#filesMd").hidden = name !== "md";
  $("#filesMedia").hidden = name !== "media";
}
function markFilesDirty(d) {
  filesState.dirty = d;
  $("#filesDirty").hidden = !d;
}
// Visibilité / libellés des boutons selon le type de fichier et le mode courant.
function refreshFilesToolbar() {
  const isText = filesState.kind === "text";
  const mode = filesState.mode;
  const prev = $("#filesPreview");
  const edit = $("#filesEdit");
  const save = $("#filesSave");
  prev.hidden = !(isText && filesState.isMd) || mode === "edit";
  prev.textContent = mode === "md" ? "📄 Source" : "👁 Aperçu";
  edit.hidden = !isText || mode === "md";
  edit.textContent = mode === "edit" ? "✖ Quitter" : "✎ Éditer";
  save.hidden = mode !== "edit";
}

// Colorise `content` (langage déduit du chemin, repli auto). Renvoie du HTML échappé
// par hljs (sûr) ou null si indisponible.
function hlValue(content, path) {
  const lang = langForPath(path);
  try {
    if (lang && window.hljs && window.hljs.getLanguage(lang)) return window.hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
    if (window.hljs) return window.hljs.highlightAuto(content).value;
  } catch {
    /* repli texte brut */
  }
  return null;
}
// Lecture : code colorisé + gouttière de numéros de ligne.
function renderReadView() {
  const code = $("#filesCode");
  const html = hlValue(filesState.content, filesState.current);
  if (html != null) code.innerHTML = html;
  else code.textContent = filesState.content;
  code.className = "hljs";
  const lines = filesState.content.split("\n").length;
  let gutter = "";
  for (let i = 1; i <= lines; i++) gutter += i + "\n";
  $("#filesGutter").textContent = gutter;
  $("#filesScroll").scrollTop = 0;
}
// Média : lecteur compatible selon la famille.
function renderMediaView(path, kind) {
  const url = rawUrl(path);
  const el = $("#filesMedia");
  if (kind === "image") el.innerHTML = `<img src="${esc(url)}" alt="${esc(path)}" />`;
  else if (kind === "video") el.innerHTML = `<video src="${esc(url)}" controls preload="metadata"></video>`;
  else if (kind === "audio") el.innerHTML = `<audio src="${esc(url)}" controls preload="metadata"></audio>`;
  else el.innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener">Ouvrir le fichier</a>`;
}

// Édition : re-colorise la couche de fond à partir du textarea (le « \n » final garde
// la dernière ligne visible au scroll), et synchronise le défilement des deux couches.
function syncEditHl() {
  const ta = $("#filesTextarea");
  const code = $("#filesEditHl");
  const html = hlValue(ta.value, filesState.current);
  code.innerHTML = (html != null ? html : esc(ta.value)) + "\n";
  code.className = "hljs";
}
function syncEditScroll() {
  const ta = $("#filesTextarea");
  const pre = $("#filesEditHlPre");
  pre.scrollTop = ta.scrollTop;
  pre.scrollLeft = ta.scrollLeft;
}
function enterEditMode() {
  if (filesState.kind !== "text") return;
  filesState.mode = "edit";
  const ta = $("#filesTextarea");
  ta.value = filesState.content;
  syncEditHl();
  syncEditScroll();
  setFilesPanel("edit");
  refreshFilesToolbar();
  ta.focus();
}
function exitEditMode() {
  filesState.mode = "read";
  renderReadView();
  setFilesPanel("read");
  refreshFilesToolbar();
}
function toggleEdit() {
  if (filesState.mode === "edit") {
    if (filesState.dirty && !confirm("Abandonner les modifications non enregistrées ?")) return;
    markFilesDirty(false);
    exitEditMode();
  } else {
    enterEditMode();
  }
}
async function saveFile() {
  const ta = $("#filesTextarea");
  const newContent = ta.value;
  const btn = $("#filesSave");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "💾 …";
  try {
    const r = await api.send("PUT", "/api/git/file", { path: filesState.current, content: newContent });
    if (r && r.ok === false) {
      uiAlert("Échec de l'enregistrement : " + (r.error || "écriture impossible"));
      return;
    }
    filesState.content = newContent;
    markFilesDirty(false);
    toast("✅ Fichier enregistré");
  } catch (e) {
    uiAlert("Erreur : " + (e.message === "git_busy" ? "une opération git est déjà en cours sur ce repo." : e.message));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}
// Aperçu Markdown ↔ source.
function toggleMdPreview() {
  if (filesState.mode === "md") {
    exitEditMode(); // revient en lecture
    return;
  }
  filesState.mode = "md";
  $("#filesMd").innerHTML = renderMarkdown(filesState.content) || '<span class="hint">(vide)</span>';
  setFilesPanel("md");
  refreshFilesToolbar();
}
function toggleFilesFullscreen() {
  const m = $(".files-modal");
  if (m) m.classList.toggle("full");
}

async function loadFileInExplorer(path) {
  if (filesState.dirty && !confirm("Abandonner les modifications non enregistrées ?")) return;
  filesState.current = path;
  markFilesDirty(false);
  filesState.isMd = langForPath(path) === "markdown";
  $("#filesTree").querySelectorAll(".ftree-file.active").forEach((el) => el.classList.remove("active"));
  const node = $("#filesTree").querySelector(`[data-file="${CSS.escape(path)}"]`);
  if (node) node.classList.add("active");
  $("#filesPath").textContent = path;

  // Média → lecteur compatible (pas de lecture texte).
  const mk = mediaKind(path);
  if (mk) {
    filesState.kind = "media";
    filesState.mode = "media";
    filesState.content = "";
    renderMediaView(path, mk);
    setFilesPanel("media");
    refreshFilesToolbar();
    return;
  }

  // Texte (ou binaire non média).
  filesState.mode = "read";
  setFilesPanel("read");
  $("#filesCode").textContent = "Chargement…";
  $("#filesGutter").textContent = "";
  try {
    const r = await api.get("/api/git/file?path=" + encodeURIComponent(path));
    if (r.ok === false) {
      filesState.kind = "binary";
      filesState.content = "";
      $("#filesCode").className = "hljs";
      $("#filesCode").textContent = r.binary ? "📦 Fichier binaire — aperçu non disponible." : r.error || "Lecture impossible.";
      $("#filesGutter").textContent = "";
      refreshFilesToolbar();
      return;
    }
    filesState.kind = "text";
    filesState.content = r.content || "";
    renderReadView();
    refreshFilesToolbar();
  } catch (e) {
    filesState.kind = null;
    $("#filesCode").className = "hljs";
    $("#filesCode").textContent = "Erreur : " + e.message;
    refreshFilesToolbar();
  }
}

// ── Message de commit par l'IA ────────────────────────────────────────────────
async function aiCommitMessage() {
  const btn = $("#wcAiMsg");
  const staged = ((repoMgr.status && repoMgr.status.files) || []).filter((f) => f.staged).length;
  if (!staged) return uiAlert("Indexe d'abord des fichiers : l'IA rédige à partir du diff indexé.");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "✨ …";
  try {
    const r = await api.send("POST", "/api/git/commit-message", {});
    if (r.message) {
      $("#wcCommitMsg").value = r.message;
      updateCommitBtn();
    }
  } catch (e) {
    uiAlert("Échec IA : " + e.message);
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

// ── Page de configuration git ─────────────────────────────────────────────────
async function openConfigModal() {
  try {
    const c = await api.get("/api/git/config");
    $("#cfgUserName").value = c.userName || "";
    $("#cfgUserEmail").value = c.userEmail || "";
    $("#cfgAutocrlf").value = c.autocrlf || "";
    $("#cfgPullRebase").value = c.pullRebase || "";
    renderRemotes(c.remotes || []);
    $("#ghDevice").hidden = true;
    $("#cfgBackdrop").hidden = false;
    loadGithubStatus();
    loadCredentials();
    loadTrackingConfig();
  } catch (e) {
    uiAlert("Erreur config : " + e.message);
  }
}
function closeConfigModal() {
  stopGithubPoll();
  $("#cfgBackdrop").hidden = true;
}
function renderRemotes(remotes) {
  const ul = $("#cfgRemotes");
  if (!remotes.length) {
    ul.innerHTML = '<li class="empty" style="font-family:inherit">Aucun remote.</li>';
    return;
  }
  ul.innerHTML = remotes
    .map(
      (r) => `<li>
        <span class="rmt-name">${esc(r.name)}</span>
        <span class="url">${esc(r.fetch || r.push || "")}</span>
        <button class="ghost xs" data-rmt-edit="${esc(r.name)}" title="Modifier l'URL">✎</button>
        <button class="danger xs" data-rmt-del="${esc(r.name)}" title="Supprimer">🗑</button>
      </li>`
    )
    .join("");
}
async function saveConfig() {
  try {
    await api.send("POST", "/api/git/config", {
      userName: $("#cfgUserName").value.trim(),
      userEmail: $("#cfgUserEmail").value.trim(),
      autocrlf: $("#cfgAutocrlf").value,
      pullRebase: $("#cfgPullRebase").value,
    });
    closeConfigModal();
  } catch (e) {
    uiAlert("Échec : " + e.message);
  }
}

// ── Versionnement du suivi (tracking) : config globale (branche orphan + worktree) ─
function renderTrackingConfig(c) {
  $("#trkGit").checked = !!c.git;
  $("#trkPush").checked = !!c.push;
  $("#trkBranch").value = c.branch || "";
  $("#trkRemote").value = c.remote || "";
  const env = $("#trkEnvHint");
  if (c.env && (c.env.git || c.env.push)) {
    env.hidden = false;
    env.textContent =
      "Variables d'environnement actives" +
      (c.env.git ? " · MEOWTRACK_TRACKING_GIT" : "") +
      (c.env.push ? " · MEOWTRACK_TRACKING_PUSH" : "") +
      " (un réglage ci-dessus les surcharge).";
  } else {
    env.hidden = true;
  }
  const stores = (c.stores || []).map((s) => `${esc(s.slug)} : ${esc(s.mode)}`).join(" · ");
  $("#trkStatus").textContent = c.git ? `Activé — ${stores || "aucun dépôt"}` : "Désactivé.";
}
async function loadTrackingConfig() {
  try {
    renderTrackingConfig(await api.get("/api/tracking/config"));
  } catch (e) {
    $("#trkStatus").textContent = "Erreur : " + e.message;
  }
}
async function applyTrackingConfig() {
  const btn = $("#trkApply");
  btn.disabled = true;
  $("#trkStatus").textContent = "Application…";
  try {
    const c = await api.send("POST", "/api/tracking/config", {
      git: $("#trkGit").checked,
      push: $("#trkPush").checked,
      branch: $("#trkBranch").value.trim(),
      remote: $("#trkRemote").value.trim(),
    });
    renderTrackingConfig(c);
  } catch (e) {
    $("#trkStatus").textContent = "Échec : " + e.message;
  } finally {
    btn.disabled = false;
  }
}
async function commitTrackingNow() {
  const btn = $("#trkCommitNow");
  btn.disabled = true;
  $("#trkStatus").textContent = "Sauvegarde…";
  try {
    renderTrackingConfig(await api.send("POST", "/api/tracking/commit", {}));
    $("#trkStatus").textContent = "Sauvegardé. " + $("#trkStatus").textContent;
  } catch (e) {
    $("#trkStatus").textContent = "Échec : " + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── GitHub : connexion par device flow ────────────────────────────────────────
const ghAuth = { timer: null, flowId: null };

async function loadGithubStatus() {
  try {
    renderGithubStatus(await api.get("/api/git/github/status"));
  } catch {
    $("#ghStatus").textContent = "État indisponible";
  }
}
function renderGithubStatus(s) {
  const st = $("#ghStatus");
  // Pré-remplit le Client ID (sauf si l'utilisateur est en train de l'éditer).
  const inp = $("#ghClientId");
  if (document.activeElement !== inp) inp.value = s.clientId || "";
  $("#ghClientIdHint").textContent = s.clientIdFromEnv
    ? "Client ID fourni par MEOWTRACK_GITHUB_CLIENT_ID (env) — saisir une valeur ici la remplacera."
    : "OAuth App GitHub avec « Enable Device Flow » — le Client ID n'est pas secret.";
  if (!s.configured) {
    st.textContent = "Renseigne d'abord le Client ID ci-dessus, puis enregistre.";
    $("#ghConnect").hidden = true;
    $("#ghDisconnect").hidden = true;
    return;
  }
  if (s.connected) {
    st.textContent = "✓ Connecté" + (s.username ? " : " + s.username : "");
    $("#ghConnect").hidden = true;
    $("#ghDisconnect").hidden = false;
  } else {
    st.textContent = "Non connecté";
    $("#ghConnect").hidden = false;
    $("#ghDisconnect").hidden = true;
  }
}
function stopGithubPoll() {
  if (ghAuth.timer) clearTimeout(ghAuth.timer);
  ghAuth.timer = null;
  ghAuth.flowId = null;
  $("#ghDevice").hidden = true;
}
async function startGithubConnect() {
  $("#ghConnect").disabled = true;
  try {
    const r = await api.send("POST", "/api/git/github/device/start", {});
    if (r.configured === false) {
      uiAlert(r.message || "OAuth App GitHub non configurée côté serveur.");
      return;
    }
    ghAuth.flowId = r.flowId;
    $("#ghUserCode").textContent = r.userCode || "";
    if (r.verificationUri) $("#ghVerifyLink").href = r.verificationUri;
    $("#ghWait").textContent = "En attente d'autorisation…";
    $("#ghDevice").hidden = false;
    scheduleGithubPoll((r.interval || 5) * 1000);
  } catch (e) {
    uiAlert("Échec : " + e.message);
  } finally {
    $("#ghConnect").disabled = false;
  }
}
function scheduleGithubPoll(ms) {
  ghAuth.timer = setTimeout(githubPollOnce, ms);
}
async function githubPollOnce() {
  if (!ghAuth.flowId) return;
  let interval = 5000;
  try {
    const r = await api.send("POST", "/api/git/github/device/poll", { flowId: ghAuth.flowId });
    if (r.interval) interval = r.interval * 1000;
    if (r.status === "success") {
      stopGithubPoll();
      await loadGithubStatus();
      toast("Connecté à GitHub" + (r.login ? " : " + r.login : ""));
      return;
    }
    if (r.status === "error") {
      $("#ghWait").textContent = "Échec : " + (r.message || "erreur");
      ghAuth.flowId = null; // arrête le polling, garde le panneau pour afficher l'erreur
      return;
    }
    // status "pending" → on continue
  } catch {
    $("#ghWait").textContent = "Erreur réseau, nouvel essai…";
  }
  if (ghAuth.flowId) scheduleGithubPoll(interval);
}
async function disconnectGithub() {
  if (!(await uiConfirm("Oublier le credential GitHub stocké sur le serveur ?"))) return;
  try {
    await api.send("POST", "/api/git/github/disconnect", {});
  } catch (e) {
    uiAlert("Échec : " + e.message);
  }
  await loadGithubStatus();
}
async function saveGithubClientId() {
  const clientId = $("#ghClientId").value.trim();
  try {
    await api.send("POST", "/api/git/github/client-id", { clientId });
    toast(clientId ? "Client ID enregistré" : "Client ID effacé");
    await loadGithubStatus();
  } catch (e) {
    uiAlert("Échec : " + e.message);
  }
}

// ── Credentials HTTP(S) génériques (Gitea/GitLab self-hosted…) ────────────────
async function loadCredentials() {
  try {
    const r = await api.get("/api/git/credentials");
    renderCredentials(r.credentials || []);
  } catch {
    $("#credsList").innerHTML = '<li class="empty" style="font-family:inherit">État indisponible.</li>';
  }
}
function renderCredentials(list) {
  const ul = $("#credsList");
  if (!list.length) {
    ul.innerHTML = '<li class="empty" style="font-family:inherit">Aucun identifiant enregistré.</li>';
    return;
  }
  ul.innerHTML = list
    .map(
      (c) => `<li>
        <span class="rmt-name">${esc(c.protocol)}://${esc(c.host)}</span>
        <span class="url">${esc(c.username || "(sans utilisateur)")} ${c.connected ? "✓" : "⚠️ non vérifié"}</span>
        <button class="ghost xs" data-cred-edit='${esc(JSON.stringify({ protocol: c.protocol, host: c.host, username: c.username }))}' title="Mettre à jour le mot de passe">✎</button>
        <button class="danger xs" data-cred-del='${esc(JSON.stringify({ protocol: c.protocol, host: c.host, username: c.username }))}' title="Supprimer">🗑</button>
      </li>`
    )
    .join("");
}
async function addCredential() {
  const protocol = $("#credProto").value;
  const host = $("#credHost").value.trim();
  const username = $("#credUser").value.trim();
  const password = $("#credPass").value;
  if (!host || !password) return uiAlert("Hôte et mot de passe/token requis.");
  try {
    const r = await api.send("POST", "/api/git/credentials", { protocol, host, username, password });
    if (r.ok === false) return uiAlert("Échec : " + (r.output || "erreur inconnue"));
    $("#credHost").value = "";
    $("#credUser").value = "";
    $("#credPass").value = "";
    toast("Identifiant enregistré");
    await loadCredentials();
  } catch (e) {
    uiAlert("Échec : " + e.message);
  }
}
async function deleteCredential(entry) {
  if (!(await uiConfirm(`Oublier les identifiants pour ${entry.protocol}://${entry.host} ?`))) return;
  try {
    await api.send("POST", "/api/git/credentials/delete", entry);
  } catch (e) {
    uiAlert("Échec : " + e.message);
  }
  await loadCredentials();
}

// ── Câblage ───────────────────────────────────────────────────────────────────
export function initRepo() {
  // Toolbar
  $("#rgFetch").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/fetch", {})));
  $("#rgPull").addEventListener("click", () => pullSmart());
  $("#rgPush").addEventListener("click", () => {
    const setUpstream = !(repoMgr.status && repoMgr.status.upstream);
    doGit(() => api.send("POST", "/api/git/push", { setUpstream }));
  });
  $("#rgBranch").addEventListener("click", async () => {
    const name = ((await uiPrompt("Nouvelle branche", { label: "Nom (créée depuis HEAD et checkout) :" })) || "").trim();
    if (name) doGit(() => api.send("POST", "/api/git/branch", { name, checkout: true }));
  });
  $("#rgMerge").addEventListener("click", async () => {
    const locals = ((repoMgr.branches && repoMgr.branches.local) || []).filter((b) => !b.current).map((b) => b.name);
    const name = ((await uiPrompt("Fusionner une branche", { label: "Branche à fusionner dans la courante :", placeholder: locals.slice(0, 1)[0] || "" })) || "").trim();
    if (name) doGit(() => api.send("POST", "/api/git/merge", { name }), { confirmMsg: `Fusionner « ${name} » dans la branche courante ?` });
  });
  $("#rgStash").addEventListener("click", async () => {
    const message = ((await uiPrompt("Remiser (stash)", { label: "Message — optionnel :" })) || "").trim();
    doGit(() => api.send("POST", "/api/git/stash", { message, includeUntracked: true }));
  });
  $("#rgStashPop").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/stash/pop", {}), { confirmMsg: "Restaurer la dernière remise (stash pop) ?" }));
  $("#rgFiles").addEventListener("click", openFilesModal);
  $("#rgReflog").addEventListener("click", openReflog);
  $("#rgConfig").addEventListener("click", openConfigModal);
  $("#rgRefresh").addEventListener("click", () => refreshRepo());
  $("#rgAbort").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/abort", {}), { confirmMsg: "Interrompre l'opération en cours et revenir à l'état précédent ?" }));
  $("#rgContinue").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/continue", {})));

  // Modale explorateur de fichiers
  $("#filesClose").addEventListener("click", closeFilesModal);
  $("#filesFull").addEventListener("click", toggleFilesFullscreen);
  $("#filesEdit").addEventListener("click", toggleEdit);
  $("#filesSave").addEventListener("click", saveFile);
  $("#filesPreview").addEventListener("click", toggleMdPreview);
  $("#filesBackdrop").addEventListener("mousedown", (e) => {
    if (e.target === $("#filesBackdrop")) closeFilesModal();
  });
  $("#filesFilter").addEventListener("input", filterFileTree);
  // Éditeur : marque sale + re-colorise à la frappe, synchronise le défilement, Tab = 2 espaces.
  $("#filesTextarea").addEventListener("input", () => {
    markFilesDirty(true);
    syncEditHl();
  });
  $("#filesTextarea").addEventListener("scroll", syncEditScroll);
  $("#filesTextarea").addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.target;
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 2;
      markFilesDirty(true);
      syncEditHl();
    }
  });
  // Délégation : clic sur un dossier (replier/déplier) ou un fichier (afficher).
  $("#filesTree").addEventListener("click", (e) => {
    const file = e.target.closest(".ftree-file");
    if (file) {
      loadFileInExplorer(file.dataset.file);
      return;
    }
    const dirRow = e.target.closest(".ftree-dirrow");
    if (dirRow) {
      const dir = dirRow.closest(".ftree-dir");
      const open = dir.classList.toggle("open");
      const children = dir.querySelector(":scope > .ftree-children");
      if (children) children.hidden = !open;
    }
  });

  // Working tree : boutons globaux
  $("#wcStageAll").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/stage", { all: true })));
  $("#wcUnstageAll").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/unstage", { all: true })));
  $("#wcAiMsg").addEventListener("click", aiCommitMessage);
  $("#wcCommitMsg").addEventListener("input", updateCommitBtn);
  $("#wcAmend").addEventListener("change", () => {
    // En cochant « amender » sans message, on pré-remplit avec le message du dernier commit.
    if ($("#wcAmend").checked && !$("#wcCommitMsg").value.trim()) {
      const head = (repoMgr.log && repoMgr.log.commits && repoMgr.log.commits[0]) || null;
      if (head && head.subject) $("#wcCommitMsg").value = head.subject;
    }
    updateCommitBtn();
  });
  $("#wcCommitBtn").addEventListener("click", async () => {
    const message = $("#wcCommitMsg").value.trim();
    const amend = $("#wcAmend").checked;
    if (!amend && !message) return;
    if (amend && !(await uiConfirm("Réécrire le dernier commit ? (à éviter s'il a déjà été poussé)", { okLabel: "Amender" }))) return;
    const r = await doGit(() => api.send("POST", "/api/git/commit", { message, amend }));
    if (r && r.ok !== false) {
      $("#wcCommitMsg").value = "";
      $("#wcAmend").checked = false;
      updateCommitBtn();
    }
  });

  // Délégation : clic sur un fichier (diff) ou ses actions (stage/unstage/discard).
  const onFileClick = (e) => {
    const li = e.target.closest(".wc-file");
    if (!li) return;
    const path = li.dataset.path;
    const staged = li.dataset.staged === "true";
    const untracked = li.dataset.untracked === "true";
    const actBtn = e.target.closest("[data-act]");
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      if (act === "stage") doGit(() => api.send("POST", "/api/git/stage", { paths: [path] }));
      else if (act === "unstage") doGit(() => api.send("POST", "/api/git/unstage", { paths: [path] }));
      else if (act === "discard") doGit(() => api.send("POST", "/api/git/discard", { paths: [path] }), { confirmMsg: `Abandonner les modifications de « ${path} » ? (irréversible)` });
      return;
    }
    openFileDiff(path, staged, untracked);
  };
  $("#wcUnstaged").addEventListener("click", onFileClick);
  $("#wcStaged").addEventListener("click", onFileClick);

  // Graphe : clic gauche = détail ; clic droit = menu contextuel.
  $("#repoGraph").addEventListener("click", (e) => {
    const row = e.target.closest(".commit-row");
    if (row) openCommitDetail(row.dataset.hash);
  });
  $("#repoGraph").addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".commit-row");
    if (!row) return;
    e.preventDefault();
    commitCtxMenu(row.dataset.hash, e.clientX, e.clientY);
  });

  // Sidebar : clic gauche = checkout (branche) / diff (remise) ; clic droit = menu.
  $("#repoSide").addEventListener("click", (e) => {
    const local = e.target.closest("[data-branch]");
    if (local) {
      if (!local.classList.contains("current")) doGit(() => api.send("POST", "/api/git/checkout", { name: local.dataset.branch }));
      return;
    }
    const remote = e.target.closest("[data-checkout-remote]");
    if (remote) {
      doGit(() => api.send("POST", "/api/git/checkout", { name: remote.dataset.checkoutRemote }));
      return;
    }
    const stash = e.target.closest("[data-stash-ref]");
    if (stash) openStashDiff(stash.dataset.stashRef);
  });
  $("#repoSide").addEventListener("contextmenu", (e) => {
    const local = e.target.closest("[data-branch]");
    if (local) {
      e.preventDefault();
      branchCtxMenu(local.dataset.branch, e.clientX, e.clientY);
      return;
    }
    const remote = e.target.closest("[data-remote-full]");
    if (remote) {
      e.preventDefault();
      remoteBranchCtxMenu(remote.dataset.remoteFull, remote.dataset.checkoutRemote, e.clientX, e.clientY);
      return;
    }
    const stash = e.target.closest("[data-stash-ref]");
    if (stash) {
      e.preventDefault();
      stashCtxMenu(stash.dataset.stashRef, e.clientX, e.clientY);
    }
  });

  // Modale diff
  $("#diffClose").addEventListener("click", closeDiffModal);
  $("#diffBackdrop").addEventListener("mousedown", (e) => {
    if (e.target === $("#diffBackdrop")) closeDiffModal();
  });
  // Staging par hunk : action sur un bouton de hunk.
  $("#diffBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-hunk]");
    if (btn) applyHunk(Number(btn.dataset.hunk), btn.dataset.mode);
  });
  // Bouton Blame (injecté dans la barre meta du diff d'un fichier).
  $("#diffMeta").addEventListener("click", (e) => {
    if (e.target.closest("#diffBlameBtn") && currentFileDiff) openBlame(currentFileDiff.path);
  });

  // Modale config
  $("#cfgCancel").addEventListener("click", closeConfigModal);
  $("#cfgSave").addEventListener("click", saveConfig);
  $("#trkApply").addEventListener("click", applyTrackingConfig);
  $("#trkCommitNow").addEventListener("click", commitTrackingNow);
  $("#cfgBackdrop").addEventListener("mousedown", (e) => {
    if (e.target === $("#cfgBackdrop")) closeConfigModal();
  });
  // Modale config : section GitHub (device flow)
  $("#ghClientIdSave").addEventListener("click", saveGithubClientId);
  $("#ghConnect").addEventListener("click", startGithubConnect);
  $("#ghDisconnect").addEventListener("click", disconnectGithub);
  $("#ghCancel").addEventListener("click", stopGithubPoll);
  $("#ghCopyCode").addEventListener("click", () => {
    const code = $("#ghUserCode").textContent;
    if (code && navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast("Code copié")).catch(() => {});
  });
  // Modale config : credentials HTTP(S) génériques (Gitea/GitLab…)
  $("#credAdd").addEventListener("click", addCredential);
  $("#credPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addCredential();
  });
  $("#credsList").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-cred-edit]");
    if (edit) {
      const entry = JSON.parse(edit.dataset.credEdit);
      $("#credProto").value = entry.protocol || "https";
      $("#credHost").value = entry.host || "";
      $("#credUser").value = entry.username || "";
      $("#credPass").value = "";
      $("#credPass").focus();
      return;
    }
    const del = e.target.closest("[data-cred-del]");
    if (del) deleteCredential(JSON.parse(del.dataset.credDel));
  });
  $("#cfgRemoteAdd").addEventListener("click", () => {
    const name = $("#cfgRemoteName").value.trim();
    const url = $("#cfgRemoteUrl").value.trim();
    if (!name || !url) return uiAlert("Nom et URL requis.");
    doGitRemote(() => api.send("POST", "/api/git/remote", { name, url, add: true }));
  });
  $("#cfgRemotes").addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-rmt-edit]");
    if (edit) {
      const url = ((await uiPrompt("Modifier le remote", { label: `Nouvelle URL pour « ${edit.dataset.rmtEdit} » :` })) || "").trim();
      if (url) doGitRemote(() => api.send("POST", "/api/git/remote", { name: edit.dataset.rmtEdit, url, add: false }));
      return;
    }
    const del = e.target.closest("[data-rmt-del]");
    if (del && (await uiConfirm(`Supprimer le remote « ${del.dataset.rmtDel} » ?`, { danger: true }))) doGitRemote(() => api.send("POST", "/api/git/remote/delete", { name: del.dataset.rmtDel }));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#diffBackdrop").hidden) closeDiffModal();
    else if (!$("#cfgBackdrop").hidden) closeConfigModal();
  });
}

// Remote ajouté/modifié/supprimé → on recharge la config + on rafraîchit la vue.
async function doGitRemote(call) {
  try {
    const r = await call();
    if (r && r.ok === false) uiAlert("Échec : " + (r.output || "erreur inconnue"));
  } catch (e) {
    uiAlert("Erreur : " + e.message);
  }
  $("#cfgRemoteName").value = "";
  $("#cfgRemoteUrl").value = "";
  try {
    const c = await api.get("/api/git/config");
    renderRemotes(c.remotes || []);
  } catch {
    /* ignore */
  }
  refreshRepo();
}

// Suppression de branche avec repli sur -D (forcé) si non fusionnée.
async function doGitDeleteBranch(name) {
  if (!(await uiConfirm(`Supprimer la branche « ${name} » ?`, { danger: true }))) return;
  try {
    const r = await api.send("POST", "/api/git/branch/delete", { name });
    if (r.ok === false) {
      if (await uiConfirm(`Échec : ${r.output}\n\nForcer la suppression (git branch -D) ?`, { danger: true, okLabel: "Forcer" })) {
        const f = await api.send("POST", "/api/git/branch/delete", { name, force: true });
        if (f.ok === false) uiAlert("Échec : " + f.output);
      }
    }
  } catch (e) {
    uiAlert("Erreur : " + e.message);
  }
  await refreshRepo();
}
