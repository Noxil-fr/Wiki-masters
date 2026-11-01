// ==UserScript==
// @name         Wiki-Masters : prix de la collection
// @namespace    wiki-master-boosters
// @version      1.7
// @description  Ajoute un bouton "💰 Prix" qui liste les cartes de la collection triées par prix de vente moyen.
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // --- Réglages ---
  const PARALLEL = 1;                    // demandes de prix simultanées (le site met ~3 s par prix)
  const DELAY_MS = 2000;                 // pause entre deux demandes (charge modérée sur le site)
  const RARITY_ORDER = ['C', 'PC', 'R']; // de la moins rare à la plus rare ; une rareté inconnue passe en premier
  const MAX_PAGES = 100;                 // sécurité pour la pagination de la collection
  const CACHE_KEY = 'wm-prix-cache';
  const ROWS_KEY = 'wm-prix-collection'; // dernier tableau affiché, montré tout de suite au clic suivant
  const HIDDEN_KEY = 'wm-prix-masquees'; // exemplaires retirés à la main (ids d'exemplaire, pas de carte)
  const SEEN_KEY = 'wm-prix-vues';       // cartes présentes au dernier scan complet, pour repérer les nouvelles

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('%c[Prix]', 'color:#16a34a;font-weight:bold', ...a);

  // --- Cache des prix (localStorage, propre à ce navigateur) ---
  // Pas d'expiration : un prix connu n'est redemandé que via "↻ Mettre à jour tous les prix".
  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) ?? {}; } catch { return {}; }
  }
  function saveCache(cache) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
  }
  function loadHidden() {
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY)) ?? []); } catch { return new Set(); }
  }
  function saveHidden(set) {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])); } catch {}
  }
  // null = aucun scan complet encore fait (on ne marque alors rien comme nouveau).
  function loadSeen() {
    try { const a = JSON.parse(localStorage.getItem(SEEN_KEY)); return a ? new Set(a) : null; } catch { return null; }
  }
  function saveSeen(set) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify([...set])); } catch {}
  }

  // --- Fichiers sur le PC : téléchargement (export) et lecture d'un fichier choisi (import) ---
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    el('a', { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const today = () => new Date().toISOString().slice(0, 10);

  // CSV pour Excel en français : séparateur ";", virgule décimale, BOM pour les accents.
  function exportCsv() {
    if (!lastRows) return alert('Lance d’abord un scan avec "💰 Prix".');
    const num = (n) => (n == null ? '' : String(n).replace('.', ','));
    const cell = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [['Carte', 'Rareté', 'Brillante', 'Qté', 'Prix moyen', 'Total', 'Lien'].join(';')];
    for (const r of sortRows(lastRows)) {
      lines.push([cell(r.title), r.rarity, r.shiny ? 'oui' : '', r.count, num(r.price),
        num(r.price != null ? r.price * r.count : null), cell(r.url)].join(';'));
    }
    download(`wiki-masters-prix_${today()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function exportBackup() {
    download(`wiki-masters-prix_sauvegarde_${today()}.json`, JSON.stringify(loadCache(), null, 1), 'application/json');
  }

  // Fusionne la sauvegarde avec la mémoire actuelle (le prix le plus récent l'emporte).
  function importBackup() {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      try {
        const saved = JSON.parse(await input.files[0].text());
        const cache = loadCache();
        let n = 0;
        for (const [k, v] of Object.entries(saved)) {
          if (v && typeof v.at === 'number' && (!cache[k] || cache[k].at < v.at)) { cache[k] = v; n++; }
        }
        saveCache(cache);
        alert(`${n} prix restaurés. Clique sur "💰 Prix" pour les afficher.`);
      } catch (err) {
        alert(`Fichier illisible : ${err.message}`);
      }
    };
    input.click();
  }

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} sur ${url}`);
    return res.json();
  }

  // --- Collection : toutes les pages jusqu'à une page vide ---
  async function fetchCollection(onProgress) {
    const all = [];
    let firstIdPrev = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await getJson(`/api/my-collection?sort=rarity&page=${page}&stats=0`);
      const items = data.collection ?? [];
      if (!items.length || items[0].id === firstIdPrev) break; // fin, ou page ignorée par l'API
      firstIdPrev = items[0].id;
      all.push(...items);
      onProgress(`Collection : ${all.length} cartes (page ${page + 1})…`);
    }
    return all;
  }

  // Prix moyen de vente pour la rareté de la carte. null si aucune vente connue.
  async function fetchPrice(cardId, rarity) {
    const data = await getJson(`/api/marketplace/cards/${cardId}/sales?scope=summary`);
    return data.summary?.[rarity]?.average ?? null;
  }

  // --- Interface ---
  const css = `
    #wm-prix-btn { position: fixed; right: 16px; bottom: 90px; z-index: 99999; padding: 10px 14px;
      border-radius: 999px; border: 1px solid #2f3a2f; background: #16a34a; color: #fff;
      font: 600 14px system-ui, sans-serif; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.4); }
    #wm-prix-panel { position: fixed; inset: 5vh 50% auto auto; transform: translateX(50%); z-index: 99999;
      width: min(760px, calc(100vw - 32px)); max-height: 85vh; display: flex; flex-direction: column;
      background: #111311; color: #e5e7e5; border: 1px solid #2f3a2f; border-radius: 12px;
      font: 14px system-ui, sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,.6); }
    #wm-prix-panel header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 16px; border-bottom: 1px solid #2f3a2f; }
    #wm-prix-panel header strong { flex: 1; font-size: 16px; }
    #wm-prix-panel header button { background: #1f261f; color: #e5e7e5; border: 1px solid #2f3a2f;
      border-radius: 8px; padding: 6px 10px; cursor: pointer; font: inherit; }
    #wm-prix-status { padding: 8px 16px; color: #9ca39c; font-size: 13px; }
    #wm-prix-panel .wrap { overflow: auto; }
    #wm-prix-panel table { width: 100%; border-collapse: collapse; }
    #wm-prix-panel th, #wm-prix-panel td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1f261f; }
    #wm-prix-panel th { position: sticky; top: 0; background: #111311; color: #9ca39c; font-weight: 600; }
    #wm-prix-panel td.num, #wm-prix-panel th.num { text-align: right; font-variant-numeric: tabular-nums; }
    #wm-prix-panel a { color: #4ade80; text-decoration: none; }
    #wm-prix-panel a:hover { text-decoration: underline; }
    #wm-prix-panel .del { background: none; border: none; color: #6b746b; cursor: pointer; font-size: 15px; padding: 0 4px; }
    #wm-prix-panel .del:hover { color: #f87171; }
    #wm-prix-panel tr.new td { background: #14301c; }
    #wm-prix-panel header button.on { background: #16a34a; border-color: #16a34a; color: #fff; }
    #wm-prix-modal { position: fixed; inset: 0; z-index: 100000; display: grid; place-items: center;
      background: rgba(0,0,0,.6); font: 14px system-ui, sans-serif; }
    #wm-prix-modal > div { width: min(400px, calc(100vw - 32px)); padding: 20px; border-radius: 12px;
      background: #111311; color: #e5e7e5; border: 1px solid #2f3a2f; box-shadow: 0 10px 40px rgba(0,0,0,.6); }
    #wm-prix-modal p { margin: 0 0 16px; line-height: 1.4; white-space: pre-line; }
    #wm-prix-modal .actions { display: flex; justify-content: flex-end; gap: 8px; }
    #wm-prix-modal button { border-radius: 8px; padding: 8px 14px; cursor: pointer; font: inherit;
      border: 1px solid #2f3a2f; background: #1f261f; color: #e5e7e5; }
    #wm-prix-modal button.danger { background: #b91c1c; border-color: #b91c1c; color: #fff; }
  `;

  function el(tag, props = {}, children = []) {
    const e = Object.assign(document.createElement(tag), props);
    for (const c of children) e.append(c);
    return e;
  }

  let panel, statusEl, tbody, newBtn, lastRows = null, running = false, onlyNew = false;

  // Modale de confirmation. Résout true si l'utilisateur confirme ; Échap ou clic à côté = annuler.
  function confirmModal(message, okLabel) {
    return new Promise((resolve) => {
      const close = (ok) => { modal.remove(); document.removeEventListener('keydown', onKey); resolve(ok); };
      const onKey = (e) => { if (e.key === 'Escape') close(false); };
      const ok = el('button', { className: 'danger', textContent: okLabel, onclick: () => close(true) });
      const modal = el('div', { id: 'wm-prix-modal', onclick: (e) => { if (e.target === modal) close(false); } }, [
        el('div', {}, [
          el('p', { textContent: message }),
          el('div', { className: 'actions' }, [el('button', { textContent: 'Annuler', onclick: () => close(false) }), ok]),
        ]),
      ]);
      document.addEventListener('keydown', onKey);
      document.body.append(modal);
      ok.focus();
    });
  }

  async function removeRow(r) {
    const ok = await confirmModal(`Retirer « ${r.title} » du tableau ?\nElle ne réapparaîtra pas, sauf si tu obtiens un nouvel exemplaire.`, 'Retirer');
    if (!ok) return;
    const hidden = loadHidden();
    for (const id of r.itemIds ?? []) hidden.add(id);
    saveHidden(hidden);
    const i = lastRows.indexOf(r);
    if (i !== -1) lastRows.splice(i, 1); // même tableau que celui du scan en cours : la ligne ne revient pas
    render(lastRows);
  }

  function buildPanel() {
    statusEl = el('div', { id: 'wm-prix-status' });
    tbody = el('tbody');
    const head = el('tr', {}, ['#', 'Carte', 'Rareté', 'Qté', 'Prix moyen', 'Total', ''].map((h, i) =>
      el('th', { textContent: h, className: i >= 3 && i <= 5 ? 'num' : '' })));
    // Relance un scan complet et n'affiche que les cartes absentes du scan complet précédent.
    // Re-cliquer pendant que le filtre est actif ré-affiche tout.
    newBtn = el('button', {
      title: 'Rescanner toute la collection et ne montrer que les cartes obtenues depuis le dernier scan complet',
      onclick: () => {
        onlyNew = !onlyNew;
        if (onlyNew) run(false);
        else if (lastRows) render(lastRows);
      },
    });
    panel = el('div', { id: 'wm-prix-panel' }, [
      el('header', {}, [
        el('strong', { textContent: '💰 Prix de ma collection' }),
        newBtn,
        el('button', { textContent: '⬇ CSV', title: 'Télécharger le tableau pour Excel', onclick: exportCsv }),
        el('button', { textContent: '⬇ Sauvegarde', title: 'Télécharger la mémoire des prix (.json)', onclick: exportBackup }),
        el('button', { textContent: '⬆ Restaurer', title: 'Recharger un fichier de sauvegarde', onclick: importBackup }),
        el('button', {
          textContent: '↻ Mettre à jour tous les prix',
          onclick: () => confirm('Redemander le prix de TOUTES les cartes ? Ça peut prendre plusieurs minutes.') && run(true),
        }),
        el('button', { textContent: '✕', onclick: () => panel.remove() }),
      ]),
      statusEl,
      el('div', { className: 'wrap' }, [el('table', {}, [el('thead', {}, [head]), tbody])]),
    ]);
    document.body.append(panel);
  }

  const sortRows = (rows) => [...rows].sort((a, b) => (b.price ?? -1) - (a.price ?? -1));

  function render(rows) {
    lastRows = rows;
    try { localStorage.setItem(ROWS_KEY, JSON.stringify(rows)); } catch {}
    const nNew = rows.filter((r) => r.isNew).length;
    newBtn.textContent = onlyNew ? `🆕 Nouvelles (${nNew}) — tout afficher` : `🆕 Nouvelles${nNew ? ` (${nNew})` : ''}`;
    newBtn.classList.toggle('on', onlyNew);
    const shown = onlyNew ? rows.filter((r) => r.isNew) : rows;
    tbody.replaceChildren(...sortRows(shown).map((r, i) => el('tr', { className: r.isNew ? 'new' : '' }, [
      el('td', { textContent: i + 1 }),
      el('td', {}, [el('a', { href: r.url, target: '_blank', rel: 'noopener', textContent: r.title + (r.shiny ? ' ✨' : '') + (r.isNew ? ' 🆕' : '') })]),
      el('td', { textContent: r.rarity }),
      el('td', { className: 'num', textContent: r.count }),
      el('td', { className: 'num', textContent: r.price ?? (r.pending ? '…' : '—') }),
      el('td', { className: 'num', textContent: r.price != null ? r.price * r.count : '' }),
      el('td', {}, [el('button', { className: 'del', textContent: '✕', title: 'Retirer (carte vendue)', onclick: () => removeRow(r) })]),
    ])));
    if (!shown.length) {
      const msg = onlyNew ? 'Aucune nouvelle carte. Re-clique sur le bouton 🆕 pour tout afficher.' : 'Aucune carte.';
      tbody.append(el('tr', {}, [el('td', { colSpan: 7, textContent: msg, style: 'color:#9ca39c;padding:16px' })]));
    }
  }

  async function run(ignoreCache = false) {
    if (running) return;
    running = true;
    if (!panel?.isConnected) buildPanel();
    const status = (t) => { statusEl.textContent = t; };

    // Affiche tout de suite le dernier tableau connu, pendant que la collection se recharge.
    try {
      const saved = JSON.parse(localStorage.getItem(ROWS_KEY));
      if (saved?.length) { render(saved.map((r) => ({ ...r, pending: false }))); }
    } catch {}

    try {
      const items = await fetchCollection(status);

      // Oublie les exemplaires retirés qui ne sont plus dans la collection (vente finalisée).
      const hidden = loadHidden();
      const present = new Set(items.map((it) => it.id));
      for (const id of hidden) if (!present.has(id)) hidden.delete(id);
      saveHidden(hidden);

      // Une ligne par carte (les doublons sont regroupés dans "count").
      const byCard = new Map();
      for (const it of items) {
        if (hidden.has(it.id)) continue;
        const key = `${it.card_id}|${it.is_shiny}`;
        const row = byCard.get(key);
        if (row) { row.count += it.count ?? 1; row.itemIds.push(it.id); continue; }
        byCard.set(key, {
          id: it.card_id, title: it.card.wikipedia_title, url: it.card.wikipedia_url, itemIds: [it.id],
          rarity: it.card.rarity, shiny: it.is_shiny, count: it.count ?? 1, price: null, pending: true,
        });
      }
      const rows = [...byCard.values()];

      // Nouvelles = absentes du scan complet précédent, ou dont le prix n'a jamais été vérifié.
      // La liste de référence est remplacée tout de suite (la collection a été lue en entier),
      // même si les prix sont interrompus.
      const seen = loadSeen();
      const cache = loadCache();
      for (const r of rows) {
        r.isNew = (seen != null && !seen.has(`${r.id}|${r.shiny}`)) || !cache[`${r.id}|${r.rarity}`];
      }
      saveSeen(new Set(items.map((it) => `${it.card_id}|${it.is_shiny}`)));
      const nNew = rows.filter((r) => r.isNew).length;
      const newMsg = ` ${nNew} nouvelle(s) : absentes du dernier scan complet ou jamais vérifiées.`;

      // En mise à jour, les anciens prix restent affichés et en mémoire jusqu'à leur remplacement :
      // un scan interrompu ne perd rien.
      for (const r of rows) {
        const c = cache[`${r.id}|${r.rarity}`];
        if (c) { r.price = c.price; r.pending = ignoreCache; }
      }
      render(rows);

      // Les plus rares d'abord : les cartes chères apparaissent en haut dès le début.
      const rank = (r) => { const i = RARITY_ORDER.indexOf(r.rarity); return i === -1 ? Infinity : i; };
      const todo = rows.filter((r) => r.pending).sort((a, b) => rank(b) - rank(a));
      let next = 0, done = 0, blocked = null;

      async function worker() {
        while (next < todo.length && !blocked) {
          const r = todo[next++];
          try {
            r.price = await fetchPrice(r.id, r.rarity);
            cache[`${r.id}|${r.rarity}`] = { price: r.price, at: Date.now() };
            saveCache(cache);
          } catch (err) {
            log('Erreur prix', r.title, err.message);
            if (/^(403|429)/.test(err.message)) blocked = err.message.slice(0, 3);
          }
          r.pending = false;
          done++;
          status(`Prix ${done} / ${todo.length}…`);
          render(rows);
          await sleep(DELAY_MS);
        }
      }
      await Promise.all(Array.from({ length: PARALLEL }, worker));

      if (blocked) {
        status(`Arrêt : le site refuse les demandes (${blocked}). Réessaie plus tard (ou baisse PARALLEL), les prix déjà obtenus sont gardés.`);
        return;
      }

      const priced = rows.filter((r) => r.price != null);
      const total = priced.reduce((s, r) => s + r.price * r.count, 0);
      status(`${rows.length} cartes, ${priced.length} avec un prix connu. Valeur estimée totale : ${total}.${newMsg}`);
    } catch (err) {
      log(err);
      status(`Erreur : ${err.message}`);
    } finally {
      running = false;
    }
  }

  document.head.append(el('style', { textContent: css }));
  document.body.append(el('button', { id: 'wm-prix-btn', textContent: '💰 Prix', onclick: () => run(false) }));
  log('Bouton "💰 Prix" ajouté.');
})();
