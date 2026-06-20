// repo.js — bloc « Gestionnaire de dépôts (git) » : toolbar + sidebar branches,
// graphe d'historique (façon GitKraken), staging/commit, config git, auth GitHub
// (device flow) et credentials. Exporte les ponts openRepoView / initRepo.

import { $, esc, api } from "./core.js";
import { toast, showCtxMenu } from "./vibes.js";

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
    renderRepoSide();
    renderRepoGraph();
    renderWorkingTree();
  } finally {
    repoMgr.loading = false;
  }
}

// Exécute une opération git mutante, signale l'échec/les conflits, rafraîchit.
async function doGit(call, { confirmMsg } = {}) {
  if (confirmMsg && !confirm(confirmMsg)) return null;
  try {
    const r = await call();
    if (r && r.ok === false) alert("Échec git :\n" + (r.output || "erreur inconnue"));
    else if (r && typeof r.output === "string" && /CONFLICT|conflit|Merge conflict/i.test(r.output)) alert(r.output);
    await refreshRepo();
    return r;
  } catch (e) {
    alert(e.message === "git_busy" ? "Une opération git est déjà en cours sur ce repo." : "Erreur : " + e.message);
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

  html += `<div class="side-group"><h4>Remises (stash)</h4>`;
  if (!repoMgr.stashes.length) html += `<div class="side-empty">—</div>`;
  for (const s of repoMgr.stashes) html += item("stash", `${s.ref} · ${s.desc}`, "", "");
  html += `</div>`;

  $("#repoSide").innerHTML = html;
}

// Masque / ré-affiche une branche dans les sélecteurs (sans toucher le dépôt git).
async function setBranchHidden(name, hidden) {
  try {
    await api.send("POST", hidden ? "/api/git/branch/hide" : "/api/git/branch/unhide", { name });
  } catch (e) {
    alert("Erreur : " + e.message);
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
    onClick: () => {
      const newName = (window.prompt("Nouveau nom de la branche :", name) || "").trim();
      if (newName && newName !== name) doGit(() => api.send("POST", "/api/git/branch/rename", { oldName: name, newName }));
    },
  });
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
      onClick: () => {
        const name = (window.prompt("Nom du tag :", "") || "").trim();
        if (!name) return;
        const message = (window.prompt("Message du tag (vide = tag léger) :", "") || "").trim();
        doGit(() => api.send("POST", "/api/git/tag", { name, ref: hash, message }));
      },
    },
    {
      label: "Créer une branche ici…",
      onClick: () => {
        const name = (window.prompt("Nom de la branche (créée sur ce commit) :", "") || "").trim();
        if (name) doGit(() => api.send("POST", "/api/git/branch", { name, ref: hash, checkout: true }));
      },
    },
    { label: "Checkout ce commit (HEAD détaché)", onClick: () => doGit(() => api.send("POST", "/api/git/checkout-commit", { hash }), { confirmMsg: `Checkout ${short} en HEAD détaché ?` }) },
    { label: "Cherry-pick sur la branche courante", onClick: () => doGit(() => api.send("POST", "/api/git/cherry-pick", { hash }), { confirmMsg: `Cherry-pick ${short} sur la branche courante ?` }) },
    { label: "Revert ce commit", onClick: () => doGit(() => api.send("POST", "/api/git/revert", { hash }), { confirmMsg: `Créer un commit qui annule ${short} ?` }) },
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
  const code = isStaged ? f.x : f.untracked ? "?" : f.y;
  const letter = f.untracked ? "?" : ST_LETTER[code] || code || "•";
  const stCls = f.conflicted ? "conflict" : f.untracked ? "untracked" : ST_LETTER[code] ? code : "";
  const title = f.conflicted ? "conflit" : f.untracked ? "non suivi" : { M: "modifié", A: "ajouté", D: "supprimé", R: "renommé" }[code] || "modifié";
  const act = isStaged
    ? `<button class="act unstage" data-act="unstage" title="Désindexer">−</button>`
    : `<button class="act discard" data-act="discard" title="Abandonner les modifications">↶</button><button class="act stage" data-act="stage" title="Indexer">＋</button>`;
  return `<li class="wc-file" data-path="${esc(f.path)}" data-staged="${isStaged}" data-untracked="${f.untracked}">
    <span class="st ${stCls}" title="${title}">${esc(letter)}</span>
    <span class="fp" title="${esc(f.path)}"><bdi>${esc(f.path)}</bdi></span>
    ${act}
  </li>`;
}
function renderWorkingTree() {
  const st = repoMgr.status || { files: [] };
  const files = st.files || [];
  const unstaged = files.filter((f) => f.unstaged);
  const staged = files.filter((f) => f.staged);
  $("#wcUnstaged").innerHTML = unstaged.length ? unstaged.map((f) => fileRow(f, "unstaged")).join("") : `<li class="empty">Rien à indexer.</li>`;
  $("#wcStaged").innerHTML = staged.length ? staged.map((f) => fileRow(f, "staged")).join("") : `<li class="empty">Rien d'indexé.</li>`;
  $("#wcUnstagedCount").textContent = unstaged.length;
  $("#wcStagedCount").textContent = staged.length;
  updateCommitBtn();
}
function updateCommitBtn() {
  const staged = ((repoMgr.status && repoMgr.status.files) || []).filter((f) => f.staged).length;
  $("#wcCommitBtn").disabled = !(staged > 0 && $("#wcCommitMsg").value.trim());
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
}
async function openFileDiff(path, staged, untracked) {
  try {
    const r = await api.get(`/api/git/diff?path=${encodeURIComponent(path)}&staged=${staged}&untracked=${untracked}`);
    openDiffModal(path + (staged ? "  (indexé)" : ""), "", renderDiffText(r.diff));
  } catch (e) {
    alert("Erreur diff : " + e.message);
  }
}
async function openCommitDetail(hash) {
  try {
    const d = await api.get("/api/git/commit/" + encodeURIComponent(hash));
    if (d.ok === false) return alert(d.output || "commit introuvable");
    const meta = `${esc(d.author)} &lt;${esc(d.email)}&gt; · ${esc(d.date)} · <span style="font-family:ui-monospace,monospace">${esc((d.hash || "").slice(0, 10))}</span>`;
    const files = (d.files || [])
      .map((f) => `<span class="dl-meta">+${esc(f.added)} -${esc(f.deleted)}</span>  ${esc(f.path)}`)
      .join("\n");
    const body = (d.body ? esc(d.body) + "\n\n" : "") + (files || "(aucun fichier)");
    openDiffModal(d.subject || hash, meta, `<span>${body}</span>`);
  } catch (e) {
    alert("Erreur : " + e.message);
  }
}

// ── Message de commit par l'IA ────────────────────────────────────────────────
async function aiCommitMessage() {
  const btn = $("#wcAiMsg");
  const staged = ((repoMgr.status && repoMgr.status.files) || []).filter((f) => f.staged).length;
  if (!staged) return alert("Indexe d'abord des fichiers : l'IA rédige à partir du diff indexé.");
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
    alert("Échec IA : " + e.message);
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
    alert("Erreur config : " + e.message);
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
    alert("Échec : " + e.message);
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
      alert(r.message || "OAuth App GitHub non configurée côté serveur.");
      return;
    }
    ghAuth.flowId = r.flowId;
    $("#ghUserCode").textContent = r.userCode || "";
    if (r.verificationUri) $("#ghVerifyLink").href = r.verificationUri;
    $("#ghWait").textContent = "En attente d'autorisation…";
    $("#ghDevice").hidden = false;
    scheduleGithubPoll((r.interval || 5) * 1000);
  } catch (e) {
    alert("Échec : " + e.message);
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
  if (!confirm("Oublier le credential GitHub stocké sur le serveur ?")) return;
  try {
    await api.send("POST", "/api/git/github/disconnect", {});
  } catch (e) {
    alert("Échec : " + e.message);
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
    alert("Échec : " + e.message);
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
  if (!host || !password) return alert("Hôte et mot de passe/token requis.");
  try {
    const r = await api.send("POST", "/api/git/credentials", { protocol, host, username, password });
    if (r.ok === false) return alert("Échec : " + (r.output || "erreur inconnue"));
    $("#credHost").value = "";
    $("#credUser").value = "";
    $("#credPass").value = "";
    toast("Identifiant enregistré");
    await loadCredentials();
  } catch (e) {
    alert("Échec : " + e.message);
  }
}
async function deleteCredential(entry) {
  if (!confirm(`Oublier les identifiants pour ${entry.protocol}://${entry.host} ?`)) return;
  try {
    await api.send("POST", "/api/git/credentials/delete", entry);
  } catch (e) {
    alert("Échec : " + e.message);
  }
  await loadCredentials();
}

// ── Câblage ───────────────────────────────────────────────────────────────────
export function initRepo() {
  // Toolbar
  $("#rgFetch").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/fetch", {})));
  $("#rgPull").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/pull", {})));
  $("#rgPush").addEventListener("click", () => {
    const setUpstream = !(repoMgr.status && repoMgr.status.upstream);
    doGit(() => api.send("POST", "/api/git/push", { setUpstream }));
  });
  $("#rgBranch").addEventListener("click", () => {
    const name = (window.prompt("Nom de la nouvelle branche (créée depuis HEAD et checkout) :", "") || "").trim();
    if (name) doGit(() => api.send("POST", "/api/git/branch", { name, checkout: true }));
  });
  $("#rgMerge").addEventListener("click", () => {
    const locals = ((repoMgr.branches && repoMgr.branches.local) || []).filter((b) => !b.current).map((b) => b.name);
    const name = (window.prompt("Branche à fusionner dans la courante" + (locals.length ? ` (ex. ${locals.slice(0, 5).join(", ")})` : "") + " :", "") || "").trim();
    if (name) doGit(() => api.send("POST", "/api/git/merge", { name }), { confirmMsg: `Fusionner « ${name} » dans la branche courante ?` });
  });
  $("#rgStash").addEventListener("click", () => {
    const message = (window.prompt("Message de la remise (stash) — optionnel :", "") || "").trim();
    doGit(() => api.send("POST", "/api/git/stash", { message, includeUntracked: true }));
  });
  $("#rgStashPop").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/stash/pop", {}), { confirmMsg: "Restaurer la dernière remise (stash pop) ?" }));
  $("#rgConfig").addEventListener("click", openConfigModal);
  $("#rgRefresh").addEventListener("click", () => refreshRepo());

  // Working tree : boutons globaux
  $("#wcStageAll").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/stage", { all: true })));
  $("#wcUnstageAll").addEventListener("click", () => doGit(() => api.send("POST", "/api/git/unstage", { all: true })));
  $("#wcAiMsg").addEventListener("click", aiCommitMessage);
  $("#wcCommitMsg").addEventListener("input", updateCommitBtn);
  $("#wcCommitBtn").addEventListener("click", async () => {
    const message = $("#wcCommitMsg").value.trim();
    if (!message) return;
    const r = await doGit(() => api.send("POST", "/api/git/commit", { message }));
    if (r && r.ok !== false) $("#wcCommitMsg").value = "";
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

  // Sidebar : clic gauche = checkout ; clic droit (branche locale/distante) = menu.
  $("#repoSide").addEventListener("click", (e) => {
    const local = e.target.closest("[data-branch]");
    if (local) {
      if (!local.classList.contains("current")) doGit(() => api.send("POST", "/api/git/checkout", { name: local.dataset.branch }));
      return;
    }
    const remote = e.target.closest("[data-checkout-remote]");
    if (remote) doGit(() => api.send("POST", "/api/git/checkout", { name: remote.dataset.checkoutRemote }));
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
    }
  });

  // Modale diff
  $("#diffClose").addEventListener("click", closeDiffModal);
  $("#diffBackdrop").addEventListener("mousedown", (e) => {
    if (e.target === $("#diffBackdrop")) closeDiffModal();
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
    if (!name || !url) return alert("Nom et URL requis.");
    doGitRemote(() => api.send("POST", "/api/git/remote", { name, url, add: true }));
  });
  $("#cfgRemotes").addEventListener("click", (e) => {
    const edit = e.target.closest("[data-rmt-edit]");
    if (edit) {
      const url = (window.prompt(`Nouvelle URL pour « ${edit.dataset.rmtEdit} » :`, "") || "").trim();
      if (url) doGitRemote(() => api.send("POST", "/api/git/remote", { name: edit.dataset.rmtEdit, url, add: false }));
      return;
    }
    const del = e.target.closest("[data-rmt-del]");
    if (del && confirm(`Supprimer le remote « ${del.dataset.rmtDel} » ?`)) doGitRemote(() => api.send("POST", "/api/git/remote/delete", { name: del.dataset.rmtDel }));
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
    if (r && r.ok === false) alert("Échec : " + (r.output || "erreur inconnue"));
  } catch (e) {
    alert("Erreur : " + e.message);
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
  if (!confirm(`Supprimer la branche « ${name} » ?`)) return;
  try {
    const r = await api.send("POST", "/api/git/branch/delete", { name });
    if (r.ok === false) {
      if (confirm(`Échec : ${r.output}\n\nForcer la suppression (git branch -D) ?`)) {
        const f = await api.send("POST", "/api/git/branch/delete", { name, force: true });
        if (f.ok === false) alert("Échec : " + f.output);
      }
    }
  } catch (e) {
    alert("Erreur : " + e.message);
  }
  await refreshRepo();
}
