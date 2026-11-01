import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const PROFILE_DIR = path.resolve('.chrome-profile');
const CAPTURES_DIR = path.resolve('captures');
const mode = process.argv[2] ?? 'run';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(`[${new Date().toLocaleTimeString()}]`, ...args);

async function launch() {
  // Profil persistant : la session (cookies) est conservée entre deux lancements.
  // channel 'msedge' = le Edge installé, moins souvent bloqué que le Chromium embarqué.
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'msedge',
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
}

async function firstVisible(page, selector, timeout = 0) {
  const loc = page.locator(selector).first();
  if (!timeout) return (await loc.isVisible()) ? loc : null;
  try {
    await loc.waitFor({ state: 'visible', timeout });
    return loc;
  } catch {
    return null;
  }
}

async function openBooster(page) {
  await page.goto(config.url, { waitUntil: 'domcontentloaded' });

  const openBtn = await firstVisible(page, config.openButton, 15_000);
  if (!openBtn) {
    log('Aucun booster disponible (bouton "Ouvrir" introuvable).');
    return false;
  }
  await openBtn.click();
  log('Booster ouvert.');
  await sleep(1500);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { selector, fallbackKey, delayMs, maxCards } = config.nextCard;

  for (let i = 1; i <= maxCards; i++) {
    if (config.screenshotEachCard) {
      await page.screenshot({ path: path.join(CAPTURES_DIR, `${stamp}_carte-${String(i).padStart(2, '0')}.png`) });
    }

    const done = await firstVisible(page, config.doneButton);
    if (done) {
      await done.click();
      log(`Fin du booster après ${i} carte(s).`);
      return true;
    }

    const next = await firstVisible(page, selector);
    if (next) await next.click();
    else await page.keyboard.press(fallbackKey);
    await sleep(delayMs);
  }

  log(`maxCards (${maxCards}) atteint sans bouton de fin — vérifie config.json.`);
  return true;
}

async function main() {
  mkdirSync(CAPTURES_DIR, { recursive: true });
  const context = await launch();
  const page = context.pages()[0] ?? (await context.newPage());

  if (mode === 'login') {
    await page.goto(config.url);
    log('Connecte-toi dans la fenêtre, puis ferme-la. La session sera mémorisée.');
    await new Promise((r) => context.on('close', r));
    return;
  }

  if (mode === 'once') {
    await openBooster(page);
    await context.close();
    return;
  }

  // mode 'run' : boucle infinie
  while (true) {
    try {
      // Ouvre tous les boosters en attente (au cas où plusieurs se sont accumulés).
      while (await openBooster(page)) await sleep(2000);
    } catch (err) {
      log('Erreur :', err.message);
    }
    const waitMs = config.intervalMinutes * 60_000 + 30_000; // +30 s de marge
    log(`Prochaine tentative dans ${config.intervalMinutes} min.`);
    await sleep(waitMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
