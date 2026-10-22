import { test, expect, type Page } from '@playwright/test';

// These tests play the real game in Chromium. Combat runs with a test-only
// invulnerability flag and a sped-up clock so a fight finishes in seconds.
const SHOTS = 'test-results/shots';
// Software WebGL in CI sandboxes can drop to a few frames per second; give whole flows room.
test.describe.configure({ timeout: 300_000 });

async function startRun(page: Page, callsign = 'E2E') {
  await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Ghost\s*Dreadnought/i })).toBeVisible();
  await page.fill('#callsign', callsign);
  await page.click('#btn-new');
  await expect(page.locator('svg[aria-label^="Sector"]')).toBeVisible();
}
async function clickNode(page: Page, type?: string) {
  const sel = type ? `.node.reach[data-type="${type}"] circle.base` : '.node.reach circle.base';
  const node = page.locator(sel).first();
  await node.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const bb = (await node.boundingBox())!;
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
}
const gd = <T>(page: Page, f: string) => page.evaluate(`(() => { const g = window.__gd; return ${f}; })()`) as Promise<T>;
async function fast(page: Page) { await gd(page, '(g.god(true), g.debug.timeScale = 8)'); }
async function winFight(page: Page) {
  await expect.poll(() => gd<string>(page, 'g.S.mode'), { timeout: 30_000 }).toBe('play');
  await fast(page);
  if (await gd<boolean>(page, "g.S.enc.kind === 'elite'")) await expect.poll(() => gd<boolean>(page, '!!g.S.elite'), { timeout: 90_000 }).toBe(true);
  await gd(page, 'g.winNow()');
}

test('title, map and a full fight with reward and refit', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('.registry')).toContainText(/online|offline/);
  await page.screenshot({ path: `${SHOTS}/01-title.png` });
  await page.fill('#callsign', 'E2E');
  await page.click('#btn-new');
  await expect(page.locator('svg[aria-label="Sector 1 route map"]')).toBeVisible();
  const types = await gd<string[]>(page, 'g.reachableTypes()');
  expect(types.length).toBeGreaterThan(1);
  expect(new Set(types)).toEqual(new Set(['fight']));
  await expect(page.locator('.card.intel')).toContainText(/Ghost of|defense core/);
  await page.screenshot({ path: `${SHOTS}/02-map.png` });

  await clickNode(page);
  await expect.poll(() => gd<string>(page, 'g.S.mode'), { timeout: 30_000 }).toBe('play');
  await gd(page, '(g.god(true), g.debug.timeScale = 8)');
  await expect.poll(() => gd<number>(page, 'g.S.enemies.length + g.S.eb.length'), { timeout: 60_000 }).toBeGreaterThan(2);
  await page.screenshot({ path: `${SHOTS}/03-combat.png` });
  await expect.poll(() => gd<number>(page, 'g.S.kills'), { timeout: 60_000 }).toBeGreaterThan(0);
  const scrapBefore = await gd<number>(page, 'g.run.scrap');
  await gd(page, 'g.winNow()');
  await expect(page.getByRole('heading', { name: 'Salvage' })).toBeVisible({ timeout: 120_000 });
  expect(await gd<number>(page, 'g.run.scrap')).toBeGreaterThanOrEqual(scrapBefore);
  await page.screenshot({ path: `${SHOTS}/04-reward.png` });
  const invBefore = await gd<number>(page, 'g.run.inv.length');
  await page.locator('.pcard').first().click();
  await expect(page.locator('.toast')).toContainText('cargo hold');
  expect(await gd<number>(page, 'g.run.inv.length')).toBe(invBefore + 1);
  expect(await gd<number>(page, 'g.run.visited.length')).toBe(1);

  // Refit: mount the starter armor plate into the empty engine bay.
  await page.click('#btn-refit');
  await expect(page.getByRole('heading', { name: 'Refit ship' })).toBeVisible();
  const plateIdx = await gd<number>(page, "g.run.inv.findIndex(p => p.id === 'plate')");
  await page.click(`[data-inv="${plateIdx}"]`);
  await page.locator('.mtile.empty.cand').first().click();
  await expect(page.locator('.rf-toast')).toContainText('mounted');
  expect(await gd<boolean>(page, "g.run.build.sections.some(s => s.slots.some(p => p && p.id === 'plate'))")).toBe(true);
  await page.screenshot({ path: `${SHOTS}/05-refit.png`, fullPage: true });
  await page.click('#btn-done');
  await expect(page.locator('svg[aria-label="Sector 1 route map"]')).toBeVisible();
});

/** A real mouse drag: press on `from`, travel, hover `to` (checked by `mid` while held), release. */
async function drag(page: Page, from: string, to: string | (() => Promise<string>), mid?: () => Promise<void>) {
  const box = async (sel: string) => { const b = (await page.locator(sel).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const a = await box(from);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(a.x + 14, a.y + 10, { steps: 3 });
  const b = await box(typeof to === 'string' ? to : await to());
  await page.mouse.move(b.x, b.y, { steps: 8 });
  if (mid) await mid();
  await page.mouse.up();
  await page.waitForTimeout(400);
}

test('refit board: drag to equip, swap mounts, unmount, reorder sections, keyboard, and buy from the counter', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await startRun(page);
  await gd(page, "(g.run.inv.push({ id: 'flak', tier: 2, uid: 99001 }), g.addScrap(1500))");
  await page.click('#btn-refit');
  await expect(page.getByRole('heading', { name: 'Refit ship' })).toBeVisible();
  // Every mount is called out: one socket tile and one leader line per mount.
  const mounts = await gd<number>(page, 'g.run.build.sections.reduce((a, s) => a + s.slots.length, 0)');
  await expect(page.locator('.mtile')).toHaveCount(mounts);
  await expect(page.locator('.board-lines .lead')).toHaveCount(mounts);
  await page.screenshot({ path: `${SHOTS}/15-refit-board.png` });

  // Drag the flak battery from the hold onto the port battery: weapon mounts light up, the utility bay dims with its reason.
  const flak = await gd<number>(page, "g.run.inv.findIndex(p => p.id === 'flak')");
  await drag(page, `[data-inv="${flak}"]`, '[data-slot="1-0"]', async () => {
    await expect(page.locator('[data-slot="1-0"]')).toHaveClass(/\bcand\b/);
    await expect(page.locator('[data-slot="1-0"]')).toHaveClass(/\bover\b/);
    await expect(page.locator('[data-slot="2-0"]')).toHaveClass(/\bnope\b/);
    await expect(page.locator('[data-slot="2-0"] .mt-say')).toHaveText(/Fittings only/i);
    await expect(page.locator('.board-lines .arc-w.hot')).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/16-refit-drag.png` });
  });
  expect(await gd<string>(page, 'g.run.build.sections[1].slots[0].id')).toBe('flak');
  expect(await gd<boolean>(page, "g.run.inv.some(p => p.id === 'pulse')")).toBe(true);
  await expect(page.locator('.rf-toast')).toContainText('mounted');

  // Swap: the centre bomb bay onto the bow; the bow gun moves across into the battery centre.
  await drag(page, '[data-slot="1-1"]', '[data-slot="0-0"]');
  expect(await gd<string>(page, 'g.run.build.sections[0].slots[0].id')).toBe('bomb');
  expect(await gd<string>(page, 'g.run.build.sections[1].slots[1].id')).toBe('pulse');

  // A part dropped on the wrong kind of socket is refused and nothing moves.
  const plate = await gd<number>(page, "g.run.inv.findIndex(p => p.id === 'plate')");
  const before = await gd<string>(page, 'JSON.stringify(g.run.build.sections.map(s => s.slots.map(p => p && p.id)))');
  await drag(page, `[data-inv="${plate}"]`, '[data-slot="1-2"]');
  expect(await gd<string>(page, 'JSON.stringify(g.run.build.sections.map(s => s.slots.map(p => p && p.id)))')).toBe(before);
  await expect(page.locator('.rf-toast')).toContainText('needs a utility bay');

  // Back to the hold.
  const inv0 = await gd<number>(page, 'g.run.inv.length');
  await drag(page, '[data-slot="0-0"]', '.rf-hold');
  expect(await gd<unknown>(page, 'g.run.build.sections[0].slots[0]')).toBe(null);
  expect(await gd<number>(page, 'g.run.inv.length')).toBe(inv0 + 1);

  // Keyboard: pick the plate in the hold with Enter, place it in the engine bay with Enter.
  const plate2 = await gd<number>(page, "g.run.inv.findIndex(p => p.id === 'plate')");
  await page.focus(`[data-inv="${plate2}"]`); await page.keyboard.press('Enter');
  await expect(page.locator('[data-slot="2-0"]')).toHaveClass(/\bcand\b/);
  await page.focus('[data-slot="2-0"]'); await page.keyboard.press('Enter');
  expect(await gd<string>(page, 'g.run.build.sections[2].slots[0].id')).toBe('plate');

  // Sections: drag the engine block forward of the battery.
  await drag(page, 'li.sec[data-sec="2"] .sec-nm', 'li.sec[data-sec="1"]');
  expect(await gd<string>(page, "g.run.build.sections.map(s => s.type).join(',')")).toBe('bridge,engine,battery');
  expect(await page.evaluate(() => localStorage.getItem('gd.run.v4') ?? '')).toContain('"engine"');
  await page.screenshot({ path: `${SHOTS}/17-refit-after.png` });
  await page.click('#btn-done');
  await expect(page.locator('svg[aria-label^="Sector"]')).toBeVisible();

  // The quartermaster's counter comes along to the refit bay: drag a slip onto a lit socket to buy and mount it.
  await gd(page, "g.forceNext('merchant')");
  await expect(page.getByRole('heading', { name: 'Merchant' })).toBeVisible();
  await page.getByRole('button', { name: /Refit ship/ }).click();
  await expect(page.locator('[data-mkt]').first()).toBeVisible();
  const scrap0 = await gd<number>(page, 'g.run.scrap');
  await drag(page, '[data-mkt]:not(.short)', async () => { await expect(page.locator('.mtile.cand').first()).toBeVisible(); return '.mtile.cand'; });
  expect(await gd<number>(page, 'g.run.scrap')).toBeLessThan(scrap0);
  await expect(page.locator('.rf-toast')).toContainText('mounted');
});

test('merchant, event, drydock, derelict and elite nodes', async ({ page }) => {
  await startRun(page);
  await gd(page, 'g.addScrap(2000)');

  // merchant
  await gd(page, "g.forceNext('merchant')");
  await expect(page.getByRole('heading', { name: 'Merchant' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/06-merchant.png`, fullPage: true });
  const inv0 = await gd<number>(page, 'g.run.inv.length');
  await page.locator('.pcard:not([disabled])').first().click();
  expect(await gd<number>(page, 'g.run.inv.length')).toBe(inv0 + 1);
  const secs0 = await gd<number>(page, 'g.run.build.sections.length');
  await page.locator('button.pcard', { hasText: /hull ·/ }).first().click();
  expect(await gd<number>(page, 'g.run.build.sections.length')).toBe(secs0 + 1);
  await page.click('#btn-leave');

  // event
  await gd(page, "g.forceNext('event')");
  await expect(page.locator('.eyebrow', { hasText: 'Unknown signal' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/07-event.png` });
  await page.locator('.choice:not([disabled])').first().click();
  await expect(page.locator('.outcome')).toBeVisible();
  if (await page.getByRole('button', { name: 'Engage' }).isVisible()) {
    await page.getByRole('button', { name: 'Engage' }).click();
    await winFight(page);
    await expect(page.getByRole('heading', { name: 'Salvage' })).toBeVisible({ timeout: 120_000 });
    await page.locator('.pcard').first().click();
  } else await page.click('#btn-continue');
  await expect(page.locator('svg[aria-label^="Sector"]')).toBeVisible();

  // drydock: upgrade a part
  await gd(page, "g.forceNext('drydock')");
  await expect(page.getByRole('heading', { name: 'Drydock' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/08-drydock.png` });
  const tiers0 = await gd<number>(page, 'g.run.build.sections.flatMap(s => s.slots).concat(g.run.inv).reduce((a, p) => a + (p ? p.tier : 0), 0)');
  await page.click('#dock-upgrade');
  await page.locator('.pcard').first().click();
  expect(await gd<number>(page, 'g.run.build.sections.flatMap(s => s.slots).concat(g.run.inv).reduce((a, p) => a + (p ? p.tier : 0), 0)')).toBe(tiers0 + 1);

  // derelict: relic
  const relics0 = await gd<number>(page, 'g.run.relics.length');
  await gd(page, "g.forceNext('derelict')");
  await page.click('#btn-open');
  await expect(page.getByRole('heading', { name: 'Strongroom opened' })).toBeVisible();
  expect(await gd<number>(page, 'g.run.relics.length')).toBe(relics0 + 1);
  await page.click('#btn-continue');

  // elite
  await gd(page, "g.forceNext('elite')");
  await expect.poll(() => gd<string>(page, 'g.S.mode'), { timeout: 30_000 }).toBe('play');
  await gd(page, '(g.god(true), g.debug.timeScale = 8)');
  await expect.poll(() => gd<boolean>(page, '!!g.S.elite'), { timeout: 90_000 }).toBe(true);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/09-elite.png` });
  await gd(page, 'g.winNow()');
  await expect(page.getByRole('heading', { name: 'Salvage' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('heading', { name: 'Relic recovered' })).toBeVisible();
  expect(await gd<number>(page, 'g.run.stats.elites')).toBe(1);
});

test('boss fight leads to salvage, relic and the next sector', async ({ page }) => {
  await startRun(page);
  await gd(page, "(() => { const r = g.run; const n = Object.values(r.map.nodes).find(n => n.floor === 9); r.at = n.id; r.visited.push(n.id); })()");
  await expect.poll(() => gd<boolean>(page, '!!g.run.bossGhost'), { timeout: 15_000 }).toBe(true);
  await gd(page, "g.travelTo('boss')");
  await expect.poll(() => gd<string>(page, 'g.S.mode'), { timeout: 30_000 }).toBe('play');
  await gd(page, '(g.god(true), g.debug.timeScale = 10)');
  await expect.poll(() => gd<boolean>(page, '!!(g.S.boss && g.S.boss.entered)'), { timeout: 150_000 }).toBe(true);
  await gd(page, '(g.god(true), g.debug.timeScale = 10)');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/10-boss.png` });
  await gd(page, 'g.winNow()');
  await expect(page.getByRole('heading', { name: /^Salvage:/ })).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: `${SHOTS}/11-boss-salvage.png` });
  await page.locator('.pcard').first().click();
  await expect(page.getByRole('heading', { name: 'Choose a relic' })).toBeVisible();
  await page.locator('.pcard').first().click();
  await expect(page.locator('svg[aria-label="Sector 2 route map"]')).toBeVisible();
  expect(await gd<number>(page, 'g.run.stats.bosses')).toBe(1);
});

test('dying uploads a ghost that becomes the next boss', async ({ page, request }) => {
  const name = `GHOST${Date.now() % 100000}`;
  await startRun(page, name);
  await clickNode(page);
  await expect.poll(() => gd<string>(page, 'g.S.mode'), { timeout: 30_000 }).toBe('play');
  await gd(page, '(g.debug.timeScale = 8, g.killPlayer())');
  await expect(page.getByRole('heading', { name: 'Dreadnought down' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('ghost-status')).toContainText('Pilots who reach', { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/12-death.png` });
  const res = await request.get('/api/ghosts?sector=1');
  const body = await res.json();
  expect(body.count).toBeGreaterThan(0);
  // Fresh run from the same browser: the only ghost may be our own, which the boss pool still allows.
  await page.click('#btn-again');
  await page.fill('#callsign', 'E2E');
  await page.click('#btn-new');
  await expect(page.locator('.card.intel')).toContainText('Ghost of', { timeout: 15_000 });
});

test('a run survives a reload and can be continued', async ({ page }) => {
  await startRun(page);
  await clickNode(page);
  await winFight(page);
  await expect(page.getByRole('heading', { name: 'Salvage' })).toBeVisible({ timeout: 120_000 });
  await page.locator('.pcard').first().click();
  const scrap = await gd<number>(page, 'Math.floor(g.run.scrap)');
  await page.reload();
  await expect(page.locator('#btn-continue')).toBeVisible();
  await page.click('#btn-continue');
  await expect(page.locator('svg[aria-label="Sector 1 route map"]')).toBeVisible();
  expect(await gd<number>(page, 'g.run.visited.length')).toBe(1);
  expect(await gd<number>(page, 'Math.floor(g.run.scrap)')).toBe(scrap);
});

test('phone layout has no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startRun(page);
  await page.screenshot({ path: `${SHOTS}/13-phone-map.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await clickNode(page);
  await expect.poll(() => gd<string>(page, 'g.S.mode'), { timeout: 30_000 }).toBe('play');
  await gd(page, '(g.god(true), g.debug.timeScale = 8)');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/14-phone-combat.png` });
});

test('combat: Overdrive fires on Space, batteries report arcs, carnage and hitstop state exist', async ({ page }) => {
  await startRun(page);
  await clickNode(page);
  await expect.poll(() => gd<string>(page, 'g.S.mode'), { timeout: 30_000 }).toBe('play');
  await gd(page, '(g.god(true), g.debug.timeScale = 8)');
  expect(await gd<string[]>(page, 'g.S.P.dv.mounts.map(m => m.arc)')).toEqual(['bow', 'broadside', 'ventral', 'broadside', 'internal']);
  expect(await gd<string>(page, 'g.S.overdrive.kind')).toBe('lance');
  await gd(page, 'g.S.overdrive.charge = 1');
  await page.keyboard.press('Space');
  await expect.poll(() => gd<boolean>(page, 'g.S.overdrive.active'), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => gd<boolean>(page, '!!g.S.overdrive.beam'), { timeout: 30_000 }).toBe(true);
  await page.screenshot({ path: `${SHOTS}/15-overdrive.png` });
  expect(await gd<number>(page, 'g.S.carnage.mult')).toBeGreaterThanOrEqual(1);
  expect(typeof await gd<number>(page, 'g.S.P.vx')).toBe('number');
  await expect.poll(() => gd<number>(page, 'g.S.stats.broadsides'), { timeout: 120_000 }).toBeGreaterThan(0);
});

test('fleet loop: admiralty, locked hulls and the daily strike', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('.launch')).toBeVisible();
  await expect(page.locator('[data-hull="vanguard"]')).toBeEnabled();
  await expect(page.locator('[data-hull="bastion"]')).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/16-launch.png` });
  await page.click('#btn-admiralty');
  await expect(page.getByRole('heading', { name: 'Ensign' })).toBeVisible();
  await page.click('[data-tab="goals"]');
  await expect(page.locator('[data-goal="victory"]')).toBeVisible();
  await page.click('[data-tab="codex"]');
  await expect(page.locator('.codex')).toContainText('Enemies');
  await page.screenshot({ path: `${SHOTS}/17-admiralty.png`, fullPage: true });
  await page.click('#btn-back');
  await page.fill('#callsign', 'DAILY');
  await page.click('#btn-daily');
  await expect(page.getByTestId('daily-roster')).toBeVisible();
  await page.click('#btn-daily-launch');
  await expect(page.locator('svg[aria-label="Sector 1 route map"]')).toBeVisible();
  // the daily strike runs on UTC days
  expect(await gd<string>(page, 'g.run.daily')).toBe(new Date().toISOString().slice(0, 10));
  expect(await gd<string>(page, 'g.run.hull')).toBe('vanguard');
});

test('victory after sector 3 banks the run, unlocks heat and offers endless', async ({ page }) => {
  await startRun(page, 'VICTOR');
  // Jump the run to the last floor of sector 3.
  await gd(page, "(() => { const r = g.run; r.sector = 3; r.bossGhost = null; const n = Object.values(r.map.nodes).find(n => n.floor === 9); r.at = n.id; r.visited.push(n.id); })()");
  await gd(page, "g.travelTo('boss')");
  await expect.poll(() => gd<string>(page, 'g.S.mode'), { timeout: 60_000 }).toBe('play');
  await gd(page, '(g.god(true), g.debug.timeScale = 10)');
  await expect.poll(() => gd<boolean>(page, '!!(g.S.boss && g.S.boss.entered)'), { timeout: 150_000 }).toBe(true);
  await gd(page, 'g.winNow()');
  await expect(page.getByRole('heading', { name: /^Salvage:/ })).toBeVisible({ timeout: 120_000 });
  await page.locator('.pcard').first().click();
  await page.locator('.pcard').first().click();
  await expect(page.getByRole('heading', { name: 'Victory' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/18-victory.png`, fullPage: true });
  // the choice survives a reload
  await page.reload();
  await page.click('#btn-continue');
  await expect(page.getByRole('heading', { name: 'Victory' })).toBeVisible();
  await page.click('#btn-retire');
  await expect(page.getByRole('heading', { name: 'Wreck report' })).toBeVisible();
  await expect(page.getByTestId('xp-total')).toContainText('XP');
  expect(await gd<number>(page, 'g.profile.stats.wins')).toBe(1);
  await page.screenshot({ path: `${SHOTS}/19-port.png`, fullPage: true });
  await page.click('#btn-home');
  await expect(page.locator('[data-heat="1"]')).toBeVisible();
  await expect(page.locator('#btn-continue')).toHaveCount(0);
});

test('daily strike duty roster: briefing, filing on death, own row marked, offline fallback', async ({ page, request }) => {
  const today = new Date().toISOString().slice(0, 10);
  const tag = Date.now() % 100000;
  const rival = `RIVAL${tag}`, me = `DUTY${tag}`;
  // the API: a rival files first; bad requests are refused
  const filed = await request.post('/api/daily', { data: { callsign: rival, date: today, score: 9_999_999, sector: 3, floor: 9, hull: 'vanguard', kills: 4000, won: true } });
  expect(filed.status()).toBe(201);
  expect((await request.get('/api/daily/2026-02-30')).status()).toBe(400);
  const board = await (await request.get(`/api/daily/${today}?callsign=${rival}`)).json();
  expect(board.count).toBeGreaterThan(0);
  expect(board.entries.length).toBeLessThanOrEqual(50);
  expect(board.you.callsign).toBe(rival);

  // title: the Daily Strike button opens the briefing with today's roster
  await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await page.goto('/');
  await page.fill('#callsign', me);
  await page.click('#btn-daily');
  const roster = page.getByTestId('daily-roster');
  await expect(roster).toBeVisible();
  await expect(page.getByTestId('roster-status')).toContainText('End of roster', { timeout: 15_000 });
  await expect(roster.locator('.rs-row', { hasText: rival })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/20-daily-briefing.png` });
  await page.click('#btn-daily-launch');
  await expect(page.locator('svg[aria-label="Sector 1 route map"]')).toBeVisible();

  // die: the run is filed and the roster prints on the wreck report with our row highlighted
  await clickNode(page);
  await expect.poll(() => gd<string>(page, 'g.S.mode'), { timeout: 30_000 }).toBe('play');
  await gd(page, '(g.debug.timeScale = 8, g.killPlayer())');
  await expect(page.getByRole('heading', { name: 'Dreadnought down' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('roster-status')).toContainText(/Filed .* pts/, { timeout: 20_000 });
  await expect(roster.locator('.rs-row.you')).toContainText(me);
  await roster.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/21-daily-roster.png` });
  const after = await (await request.get(`/api/daily/${today}?callsign=${me}`)).json();
  expect(after.you).toMatchObject({ callsign: me, hull: 'vanguard', won: false });
  expect(after.you.score).toBe(await gd<number>(page, 'g.profile.daily.score'));

  // registry offline: the briefing says so and shows this device's own copy, unranked
  await page.route('**/api/daily**', (r) => r.abort());
  await page.click('#btn-again');
  await page.click('#btn-daily');
  await expect(page.getByTestId('roster-status')).toContainText('No carrier', { timeout: 15_000 });
  await expect(roster.locator('.rs-row.you.local')).toContainText(me);
  await page.waitForTimeout(1500); // let the title's boot reveal finish behind the modal
  await page.screenshot({ path: `${SHOTS}/22-daily-offline.png` });
  await page.click('#btn-daily-close');
  await expect(roster).toHaveCount(0);
});

test('gunnery: number keys pick a heavy group, the mouse aims it and the left button fires it', async ({ page }) => {
  await startRun(page, 'GUNNER');
  // a bridge rail (group 1) and a bomb bay (group 2); the pulse guns stay AUTO
  await gd(page, `(() => { const mk = (id) => ({ id, tier: 1, uid: 70000 + Math.floor(Math.random() * 1e6) });
    g.run.build.sections = [{ type: 'bridge', slots: [mk('rail')] }, { type: 'battery', slots: [mk('pulse'), mk('bomb'), mk('pulse')] }, { type: 'engine', slots: [null] }]; })()`);
  await clickNode(page);
  await expect.poll(() => gd<string>(page, 'g.S.mode'), { timeout: 30_000 }).toBe('play');
  await gd(page, 'g.god(true)');
  expect(await gd<string[]>(page, 'g.S.groups.map(x => x.family)')).toEqual(['rail', 'bomb']);
  const box = (await page.locator('#hud').boundingBox())!, k = box.width / 1600;
  const to = async (x: number, y: number) => page.mouse.move(box.x + x * k, box.y + y * k, { steps: 3 });
  const P = await gd<{ x: number; y: number }>(page, '({ x: g.S.P.x, y: g.S.P.y })');
  await page.keyboard.press('Digit2');
  expect(await gd<number>(page, 'g.aim.group')).toBe(1);
  await page.keyboard.press('KeyQ');
  expect(await gd<number>(page, 'g.aim.group')).toBe(0);
  await page.keyboard.press('Digit2');
  // bombs fall on the ground under the reticle
  await to(P.x - 140, P.y - 200);
  await expect.poll(() => gd<number>(page, 'Math.round(g.aim.x)'), { timeout: 10_000 }).toBeLessThan(P.x - 100);
  await page.mouse.down();
  expect(await gd<boolean>(page, 'g.gunnery.manual')).toBe(true);
  await expect.poll(() => gd<boolean>(page, "g.S.pb.some(b => b.kind === 'bomb' && Math.abs(b.tx - g.aim.x) < 40)"), { timeout: 30_000 }).toBe(true);
  await page.screenshot({ path: `${SHOTS}/23-gunnery-bombs.png` });
  await page.mouse.up();
  // the bridge rail cannot bear abeam, and the reticle says why
  await page.keyboard.press('Digit1');
  await to(Math.min(1560, P.x + 600), P.y + 40);
  await expect.poll(() => gd<string>(page, 'g.aim.why[g.S.groups[0].mounts[0].part.uid]'), { timeout: 10_000 }).toBe('arc');
  await page.screenshot({ path: `${SHOTS}/24-gunnery-no-bearing.png` });
  // ahead of the bow it fires
  await to(P.x + 80, Math.max(80, P.y - 400));
  await expect.poll(() => gd<string>(page, 'g.aim.why[g.S.groups[0].mounts[0].part.uid]'), { timeout: 10_000 }).toBe('');
  await page.mouse.down();
  await expect.poll(() => gd<number>(page, 'g.S.beams.filter(b => b.w === 5).length'), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.mouse.up();
});
