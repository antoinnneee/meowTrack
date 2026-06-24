---
name: meowtrack-orchestrate
description: Boucle d'orchestration agent meowtrack — réclamer la prochaine tâche prête (next), peek lecture seule, démarrer/heartbeat, et clôturer un nœud (complete/fail) avec rapport, en respectant le cycle de vie (worktree isolé, merge main entre nœuds, hint compact, request_input quand le plan laisse un choix utilisateur). Utiliser quand on demande de « faire tourner l'orchestrateur », d'exécuter le prochain nœud/jalon, ou de dérouler le backlog Vibes en mode agent. Couvre les outils MCP meowtrack_node_next/peek/start/complete/fail/heartbeat/runs/reviews.
---

# meowtrack — orchestration (boucle agent)

Setup commun (base URL, auth `mt`, `?repo=`) : voir le skill **`meowtrack`**. Token de
dépôt → `?repo=` implicite ; sinon ajouter `?repo=<slug>`. `OWNER` identifie le worker
(ex. `claude-code`).

Meowtrack est **passif** : il fournit la file de travail et le graphe de dépendances, il
**n'exécute rien**. C'est l'agent qui **tire** le travail, le fait avec ses propres outils
(Read/Edit/Bash/git), puis rend compte.

## Cycle de vie (à respecter par l'agent)

```
tant que (node = POST /api/nodes/next) :
    si le plan/notes du nœud présentent des OPTIONS à trancher (A/B…) sans défaut désigné :
        PATCH …{status:"waiting", pendingInfo:"résume le choix}   # request_input — NE PAS clore
        continuer                                                  # rendre la main
    … faire le travail dans un WORKTREE ISOLÉ (ne pas polluer la copie principale) …
    écrire éventuellement .meowtrack/runs/<ref>.json (rapport + points de revue)
    POST /api/nodes/<ref>/complete { owner, summary, testResult, report? }
    merger la branche de travail dans `main` (+push) AVANT le nœud suivant
    si réponse.hint == "compact_suggested" et contexte chargé : /compact
```

Détails complets : `docs/orchestrateur-mcp.md`.

## Outils MCP → routes HTTP

| Opération | Route |
|---|---|
| réclamer la prochaine tâche prête (+bail) | `POST /api/nodes/next { owner, branch? }` |
| peek (indicatif, sans réclamer) | `GET /api/nodes/next` |
| démarrage MANUEL d'un nœud précis | `POST /api/nodes/:ref/start { owner?, branch? }` |
| prolonger le bail (tâche longue) | `POST /api/nodes/:ref/heartbeat { owner }` |
| clôturer (ingère le rapport → done\|review) | `POST /api/nodes/:ref/complete { owner, summary?, branch?, testResult?, report? }` |
| échec borné | `POST /api/nodes/:ref/fail { owner, error, branch? }` |
| historique d'exécution d'un nœud | `GET /api/nodes/:ref/runs` |
| points de revue d'un nœud | `GET /api/nodes/:ref/reviews?state=` |
| file globale des points de revue | `GET /api/nodes/reviews?state=open` |
| timeline de tous les runs récents | `GET /api/nodes/runs?limit=&offset=&state=` |

`testResult` = pass|fail|skipped. `complete` renvoie `{ state: "done"|"review", affected, reviews,
hint? }` : `state:"review"` = un point de revue **bloquant** a été soulevé (le nœud n'est pas
clos tant qu'il n'est pas résolu).

## Exemples

```bash
OWNER=claude-code

# Réclamer la prochaine tâche prête (atomique : pose un bail au nom du worker)
node=$(mt -X POST -H 'Content-Type: application/json' -d "{\"owner\":\"$OWNER\"}" "$MT/api/nodes/next")
ref=$(echo "$node" | jq -r '.node.ref // empty')
echo "$node" | jq '.node | {ref, title, status}'

# Peek : voir la prochaine feuille dispatchable SANS la réclamer
mt "$MT/api/nodes/next" | jq '.node | {ref, title}'

# Clôturer avec un compte-rendu et le résultat des tests
mt -X POST -H 'Content-Type: application/json' -d "{
  \"owner\":\"$OWNER\",\"summary\":\"Implémenté X ; 12/12 tests OK.\",\"testResult\":\"pass\"
}" "$MT/api/nodes/$ref/complete" | jq '{state, affected, hint}'

# Heartbeat sur une tâche longue (sinon le bail expire → re-réclamation)
mt -X POST -H 'Content-Type: application/json' -d "{\"owner\":\"$OWNER\"}" "$MT/api/nodes/$ref/heartbeat" | jq '.ok'

# Échec borné (libère le bail, incrémente runAttempts)
mt -X POST -H 'Content-Type: application/json' -d "{\"owner\":\"$OWNER\",\"error\":\"build cassé\"}" "$MT/api/nodes/$ref/fail" | jq .
```

> **Garde-fou** : ne PAS clore un nœud dont le plan laisse un choix utilisateur ouvert
> (Option A/B sans défaut) en tranchant soi-même → préférer `request_input` (status
> `waiting`). Si on implémente une option par défaut recommandée, le dire dans `summary`.

Ancrage code : `routes/nodes.js` (orchestrateur), `db/nodes.js`, `db/runs.js`, `docs/orchestrateur-mcp.md`.
