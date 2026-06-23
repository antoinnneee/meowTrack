// Test NODE-351 : streamVisibleEnd — diffusion fluide du texte conversationnel en
// streaming. Avant, pumpVisible retenait TOUJOURS les 23 derniers caractères (longueur
// de la sentinelle) → la fin d'un texte court figeait jusqu'à l'arrivée du bloc d'actions
// (« texte figé puis affiché en bloc à la création des nœuds »). Désormais on ne retient
// une marge QUE si la fin du texte est un préfixe partiel de la sentinelle.
import { ACTIONS_SENTINEL, streamVisibleEnd } from "../ai/parse.js";

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗ ÉCHEC:", name); } };

try {
  // Texte normal : tout est visible, pas de bascule.
  const t1 = "Bonjour, voici mon analyse complète.";
  const r1 = streamVisibleEnd(t1);
  check("texte normal → tout visible", r1.visibleEnd === t1.length && r1.inActions === false);

  // Régression clé : texte court suivi (à terme) du bloc d'actions — pendant la frappe
  // du texte, RIEN ne doit être retenu (sauf préfixe partiel). Ici pas de partiel.
  const t2 = "Je crée les nœuds :";
  check("texte court → entièrement visible (NODE-351)", streamVisibleEnd(t2).visibleEnd === t2.length);

  // Fin = préfixe partiel de la sentinelle → on retient juste ce préfixe.
  const part = "Voici <<<MEOW";
  const r3 = streamVisibleEnd(part);
  check("préfixe partiel retenu", r3.visibleEnd === part.length - "<<<MEOW".length && r3.inActions === false);
  check("préfixe partiel : début visible", part.slice(0, r3.visibleEnd) === "Voici ");

  // Fin = un seul « < » (préfixe minimal) → retient 1 caractère.
  const lt = "texte<";
  check("un seul < retenu", streamVisibleEnd(lt).visibleEnd === lt.length - 1);

  // Sentinelle complète présente → visibleEnd = sa position, bascule en mode actions.
  const full = "Intro." + ACTIONS_SENTINEL + '{"actions":[]}';
  const r4 = streamVisibleEnd(full);
  check("sentinelle complète → visibleEnd = position", r4.visibleEnd === full.indexOf(ACTIONS_SENTINEL));
  check("sentinelle complète → inActions", r4.inActions === true);
  check("sentinelle complète → texte avant visible", full.slice(0, r4.visibleEnd) === "Intro.");

  // Texte court IMMÉDIATEMENT suivi de la sentinelle complète : tout l'intro est visible.
  const tight = "Je crée :" + ACTIONS_SENTINEL;
  const r5 = streamVisibleEnd(tight);
  check("intro collée à la sentinelle → intro entièrement visible", r5.visibleEnd === "Je crée :".length && r5.inActions === true);

  // « < » au milieu, fin normale → rien retenu.
  check("< au milieu, fin normale → tout visible", streamVisibleEnd("a<b c").visibleEnd === 5);

  // Faux partiel : « <<<x » diverge au 4e caractère → tout visible.
  check("faux partiel <<<x → tout visible", streamVisibleEnd("ab<<<x").visibleEnd === "ab<<<x".length);

  // Vide.
  const r6 = streamVisibleEnd("");
  check("vide → 0, pas d'actions", r6.visibleEnd === 0 && r6.inActions === false);

  console.log(`\n${pass} OK, ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("Erreur de test:", e);
  process.exit(1);
}
