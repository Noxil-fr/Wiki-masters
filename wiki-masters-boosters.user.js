// ==UserScript==
// @name         Wiki-Masters : ouverture auto des boosters
// @namespace    wiki-master-boosters
// @version      1.5
// @description  Ouvre les boosters et fait défiler les cartes tant que l'onglet est ouvert.
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @grant        GM_notification
// ==/UserScript==

(function () {
  'use strict';

  // --- Réglages : textes des boutons (insensible à la casse) ---
  const OPEN_TEXTS = ['ouvrir', 'open'];
  const NEXT_TEXTS = ['suivant', 'next'];
  const DONE_TEXTS = ['terminer', 'fermer', 'continuer', 'done', 'close'];
  const CHECK_EVERY_MS = 30_000; // vérifie toutes les 30 s si un booster est dispo
  const CARD_DELAY_MS = 900;     // pause entre deux cartes
  const MAX_CARDS = 20;
  const OPEN_DELAY_MIN_MS = 10_000; // attente aléatoire avant chaque ouverture de paquet…
  const OPEN_DELAY_MAX_MS = 30_000; // …entre ces deux bornes

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const log = (...a) => console.log('%c[Boosters]', 'color:#7c3aed;font-weight:bold', ...a);

  const isUsable = (el) => el && !el.disabled && el.offsetParent !== null;

  const hasWord = (txt, texts) => {
    const words = txt.toLowerCase().split(/[^\p{L}]+/u);
    return texts.some((t) => words.includes(t));
  };

  // Mot entier (évite "rouvrir", "reopen"…). Le texte peut être long : le bouton
  // contient parfois aussi le compteur de paquets.
  function findButton(texts) {
    const els = document.querySelectorAll('button, [role="button"], a');
    for (const el of els) {
      const txt = (el.innerText || el.getAttribute('aria-label') || '').trim();
      if (txt && isUsable(el) && hasWord(txt, texts)) return el;
    }
    return findClickableByText(texts);
  }

  // Secours : le "bouton" peut être une simple <div> cliquable (curseur main).
  function findClickableByText(texts) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!hasWord(node.textContent, texts)) continue;
      for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
        if (getComputedStyle(el).cursor === 'pointer') return isUsable(el) ? el : null;
      }
    }
    return null;
  }

  // Aide au diagnostic : liste les éléments visibles qui parlent d'ouvrir.
  function logOpenCandidates() {
    const found = [...document.querySelectorAll('body *')]
      .filter((el) => el.offsetParent !== null && el.children.length <= 3 && /ouvr|open/i.test(el.innerText || ''))
      .slice(0, 10)
      .map((el) => `<${el.tagName.toLowerCase()} class="${el.className}" cursor=${getComputedStyle(el).cursor}> "${el.innerText.trim().slice(0, 60)}"`);
    log('Aucun bouton "Ouvrir" trouvé alors que des paquets sont dispo. Candidats :', found.length ? '\n' + found.join('\n') : 'aucun');
  }

  // Le bouton "suivant" n'a pas de texte : c'est une flèche SVG (chevron droit).
  // Plusieurs chevrons peuvent exister (navigation, carrousels) : on privilégie celui
  // d'une fenêtre modale, sinon le dernier visible (le booster est affiché par-dessus).
  function findNextArrow() {
    const candidates = [...document.querySelectorAll('polyline[points="9 18 15 12 9 6"]')]
      .map((p) => p.closest('button, [role="button"], a') ?? p.closest('svg')?.parentElement)
      .filter(isUsable);
    return candidates.find((b) => b.closest('[role="dialog"], [aria-modal="true"]')) ?? candidates.at(-1) ?? null;
  }

  // Clique "Terminer"/"Fermer" si l'écran de fin d'un booster est resté affiché.
  async function closeLeftoverEnd() {
    const done = findButton(DONE_TEXTS);
    if (!done) return false;
    log('Écran de fin resté ouvert : fermeture.');
    done.click();
    await sleep(1500);
    return true;
  }

  function pressArrowRight() {
    const opts = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, bubbles: true };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // Lit le compteur "8 / 10 paquets disponibles". null si introuvable.
  function packsAvailable() {
    const m = document.body.innerText.match(/(\d+)\s*\/\s*\d+\s*paquets? disponibles?/i);
    return m ? Number(m[1]) : null;
  }

  // Vérification anti-robot affichée : on ne touche à rien tant qu'elle est là.
  // Phrases précises : les cartes Wikipédia peuvent contenir le mot "robot".
  const CHALLENGE_RE = /vérification rapide|bien humain|êtes humain|pas un robot|veuillez patienter|vérification (de sécurité|en cours|du navigateur)|verify you are human|checking your browser/i;
  function challengeShown() {
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[src*="captcha"]')) return true;
    return CHALLENGE_RE.test(document.body.innerText);
  }

  let paused = false;
  let originalTitle = document.title;
  function checkChallenge() {
    const shown = challengeShown();
    if (shown && !paused) {
      log('Vérification anti-robot détectée : pause.');
      originalTitle = document.title;
      document.title = '⚠ Vérification à faire';
      GM_notification({ title: 'Wiki-Masters', text: 'Vérification anti-robot : coche la case pour reprendre.', timeout: 0 });
    }
    if (!shown && paused) {
      log('Vérification terminée : reprise.');
      document.title = originalTitle;
    }
    paused = shown;
    return shown;
  }

  let busy = false;

  async function tick() {
    if (busy) return;
    if (checkChallenge()) {
      log('En pause : vérification anti-robot détectée sur la page.');
      return;
    }
    busy = true;
    try {
      await closeLeftoverEnd();
      // Enchaîne les boosters tant qu'il en reste (max 10 par passage, par sécurité).
      for (let n = 0; n < 10; n++) {
        if (checkChallenge()) break;
        if (packsAvailable() === 0) break;
        if (!findButton(OPEN_TEXTS)) {
          if (packsAvailable()) logOpenCandidates();
          break;
        }

        // Attente aléatoire avant d'ouvrir, aussi bien au passage 0 → 1 qu'entre deux paquets.
        const wait = randomBetween(OPEN_DELAY_MIN_MS, OPEN_DELAY_MAX_MS);
        log(`Paquet disponible, ouverture dans ${Math.round(wait / 1000)} s.`);
        await sleep(wait);

        if (checkChallenge()) break;
        const left = packsAvailable();
        if (left === 0) break;
        if (!(await openOne(left))) break;
      }
    } finally {
      busy = false;
    }
  }

  async function openOne(left) {
    const openBtn = findButton(OPEN_TEXTS);
    if (!openBtn) {
      if (left !== 0) logOpenCandidates();
      return false;
    }

    log(`Booster trouvé (${left ?? '?'} dispo), ouverture…`);
    openBtn.click();
    await sleep(1500);

    for (let i = 1; i <= MAX_CARDS; i++) {
      if (checkChallenge()) return false;
      const done = findButton(DONE_TEXTS);
      if (done) {
        done.click();
        log(`Terminé après ${i} carte(s).`);
        break;
      }
      const next = findNextArrow() ?? findButton(NEXT_TEXTS);
      if (next) {
        log(`Carte ${i} → suivante`);
        next.click();
      } else if (i > 1) {
        // Le bouton de fin peut apparaître avec une animation : on lui laisse le temps.
        await sleep(1500);
        if (!(await closeLeftoverEnd())) log(`Plus de flèche "suivant" : booster terminé (${i} carte(s)).`);
        break;
      } else {
        pressArrowRight();
      }
      await sleep(CARD_DELAY_MS);
      if (i === MAX_CARDS) log(`${MAX_CARDS} cartes passées sans bouton de fin trouvé.`);
    }
    return true;
  }

  log('Script actif. Vérification toutes les', CHECK_EVERY_MS / 1000, 's.');
  setInterval(tick, CHECK_EVERY_MS);
  setInterval(checkChallenge, 5000); // détecte vite la fin de la vérification
  setTimeout(tick, 3000);
})();
