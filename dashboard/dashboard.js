// dashboard.js — point d'entrée du front (module ES). Charge le noyau et les trois
// blocs de vues, puis enregistre les initialiseurs DOMContentLoaded dans l'ordre
// historique (init du Suivi AVANT initVibes, qui câble aussi le gestionnaire git).
//
//   core.js    helpers DOM/auth/API partagés
//   issues.js  Suivi (issues) + autocomplete « @ »
//   vibes.js   Vibes (nœuds, graphe, chat IA) + toast/menu contextuel
//   repo.js    Gestionnaire de dépôts (git)
//
// Chargé via <script type="module" src="dashboard.js"> dans index.html.

import { init } from "./issues.js";
import { initVibes } from "./vibes.js";

document.addEventListener("DOMContentLoaded", init);
document.addEventListener("DOMContentLoaded", initVibes);
