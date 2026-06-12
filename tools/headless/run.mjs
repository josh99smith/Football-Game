/**
 * Headless game verification: boots vite + headless Chrome (SwiftShader WebGL), drives real
 * plays via the dev handle (window.__app), asserts ZERO page errors, and writes contact-sheet
 * screenshots to /tmp/rigqc/headless/. See tools/headless/README.md.
 *
 * Usage: node tools/headless/run.mjs [scenario...]   (default: all)
 * Scenarios: rush, pass, kickoff, pile
 */
import { spawn } from "child_process";
import * as fs from "fs";

let puppeteer;
try {
  puppeteer = (await import("puppeteer")).default;
} catch {
  console.error("puppeteer is not installed. Run: npm i -D puppeteer");
  process.exit(2);
}

const PORT = 5188;
const OUT = "/tmp/rigqc/headless";
fs.mkdirSync(OUT, { recursive: true });

const wanted = process.argv.slice(2);
const pick = (name) => wanted.length === 0 || wanted.includes(name);

// --- boot vite ---------------------------------------------------------------------------------
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: false,
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("vite did not start in 30s")), 30000);
  vite.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(t); resolve(); } });
  vite.on("exit", (c) => reject(new Error(`vite exited early (${c})`)));
});

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});

const errors = [];
let shotsTaken = 0;

/** Fresh page with the rig loaded, error collection wired. */
async function boot() {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 440, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(
    () => window.__app && window.__app.scene3d.charInfo.skinned && window.__app.scene3d.charInfo.clips >= 4,
    { timeout: 90000, polling: 500 },
  );
  return page;
}

/** Start a scrimmage play directly (bypasses the canvas play-call UI). */
async function startPlay(page, playId) {
  await page.evaluate(async (id) => {
    const lp = await import("/src/game/states/LivePlayState.ts");
    const pb = await import("/src/game/Playbook.ts");
    const pc = await import("/src/game/ai/PlayCaller.ts");
    const app = window.__app;
    app.newMatch();
    app.match.beginPractice();
    const off = pb.OFFENSE_PLAYS.find((p) => p.id === id) ?? pb.OFFENSE_PLAYS[0];
    app.setState(new lp.LivePlayState(app, off, pc.cpuDefensePlay(app.match)));
  }, playId);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  shotsTaken++;
}

// --- scenarios -----------------------------------------------------------------------------------
async function rush() {
  const page = await boot();
  await startPlay(page, "hb_dive");
  await sleep(4200);
  await shot(page, "rush_set");
  await page.keyboard.press("Space"); // snap
  await sleep(600);
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("Shift"); // turbo into the line → tackle
  for (let i = 0; i < 6; i++) { await sleep(800); await shot(page, `rush_${i}`); }
  await page.keyboard.up("ArrowRight"); await page.keyboard.up("Shift");
  await page.close();
}

async function pass() {
  const page = await boot();
  await startPlay(page, "slants");
  await sleep(4200);
  await page.keyboard.press("Space"); // snap
  await sleep(1400);
  await shot(page, "pass_drop");
  await page.keyboard.press("Space"); // throw
  for (let i = 0; i < 4; i++) { await sleep(700); await shot(page, `pass_${i}`); }
  await page.close();
}

async function kickoff() {
  const page = await boot();
  await page.evaluate(async () => {
    const { KickoffState } = await import("/src/game/states/KickoffState.ts");
    const app = window.__app;
    app.newMatch();
    app.setState(new KickoffState(app, "HOME"));
  });
  await sleep(2500);
  await shot(page, "kick_air");
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) { await sleep(900); await shot(page, `return_${i}`); }
  await page.keyboard.up("ArrowRight"); await page.keyboard.up("Shift");
  await page.close();
}

/** Repeated rushes into the line — rolls the dice on gang tackles, struggles, and pile ragdolls. */
async function pile() {
  const page = await boot();
  for (let play = 0; play < 3; play++) {
    await startPlay(page, "hb_dive");
    await sleep(3600);
    await page.keyboard.press("Space");
    await sleep(500);
    await page.keyboard.down("ArrowRight");
    await page.keyboard.down("Shift");
    await sleep(2600);                       // run into the pile
    await page.keyboard.up("ArrowRight"); await page.keyboard.up("Shift");
    await page.keyboard.press("Space");      // mash through any struggle
    await sleep(2400);                       // tackle + ragdoll + get-up window
    await shot(page, `pile_${play}`);
  }
  await page.close();
}

// --- run -----------------------------------------------------------------------------------------
const scenarios = { rush, pass, kickoff, pile };
let failed = false;
for (const [name, fn] of Object.entries(scenarios)) {
  if (!pick(name)) continue;
  process.stdout.write(`scenario ${name}… `);
  try {
    await fn();
    console.log("ok");
  } catch (e) {
    console.log(`FAILED: ${String(e).slice(0, 200)}`);
    failed = true;
  }
}

await browser.close();
vite.kill();

console.log(`\n${shotsTaken} screenshots → ${OUT}`);
if (errors.length) {
  console.error(`\n${errors.length} PAGE ERROR(S):`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.error("  •", e);
  process.exit(1);
}
if (failed) process.exit(1);
console.log("zero page errors — clean");
