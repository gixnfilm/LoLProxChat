#!/usr/bin/env node
//
// Measure the signaling server's actual distance -> volume curve, its hearing
// cut-off, and whether it honours the `allyProximity` flag.
//
// Why this exists
// ---------------
// The client re-shapes the server's proximity value, which means it has to
// know what that value means. Reading `server/src/volumes.ts` is not enough:
// on 2026-09-23 the bundled source said `1 - (d/1350)²` with no plateau, while
// the deployed server at proxchat.dant123.com was actually running
//
//     d <  900        -> 1.0
//     900 <= d < 1350 -> 1 - ((d - 900) / 450)²
//     d >= 1350       -> omitted from the response entirely
//
// The client had hardcoded the source's constants, so every distance it
// recovered was wrong, and teammates barely faded. `fadePosition()` in
// src/services/proximity-curve.ts is now written to be independent of the
// endpoints for exactly this reason — but the numbers quoted in the docs, the
// UI tooltips and tests/services/proximity-curve.test.ts still come from here.
// Re-run this if proximity ever feels wrong again, or after a server deploy.
//
//   node scripts/probe-server-curve.mjs [serverUrl]
//
// No dependencies (Node 18+ for fetch, Node 22+ for the global WebSocket).
// Opens one short-lived room with three clients; the room disappears when they
// disconnect.

const SERVER = (process.argv[2] || 'https://proxchat.dant123.com').replace(/\/$/, '');
const WS_URL = SERVER.replace(/^http/, 'ws') + '/ws';
const ROOM = 'probe-curve-' + process.pid + '-' + Date.now().toString(36);
const DISTANCES = [0, 200, 400, 600, 800, 900, 1000, 1100, 1200, 1300, 1340, 1360, 1500, 2000];

function connect(name, team, x, y) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error(name + ': connect timeout')), 15000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'join', room: ROOM, name, team }));
      ws.send(JSON.stringify({ type: 'coords', x, y }));
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function volumesFor(allyProximity) {
  const resp = await fetch(SERVER + '/compute-volumes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ myPosition: { x: 0, y: 0 }, roomId: ROOM, name: 'Me', allyProximity }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
  return (await resp.json()).peerVolumes || {};
}

const show = (v) => (v === undefined ? 'ABSENT' : v.toFixed(4));

const sockets = [];
try {
  console.log('server:', SERVER);
  console.log('room:  ', ROOM, '\n');

  // Ally shares Me's team; Enemy does not. Comparing the two columns is what
  // reveals whether allyProximity is honoured.
  const me = await connect('Me', 'ORDER', 0, 0);
  sockets.push(me);
  const ally = await connect('Ally', 'ORDER', 0, 0);
  sockets.push(ally);
  const enemy = await connect('Enemy', 'CHAOS', 0, 0);
  sockets.push(enemy);
  await wait(1500);

  const samples = [];
  console.log('dist   ally(prox)  enemy');
  for (const d of DISTANCES) {
    // Re-send a few times and let it settle: a single send races the POST, and
    // the server ages coords out after ~5 s so our own position needs refreshing.
    for (let i = 0; i < 4; i++) {
      me.send(JSON.stringify({ type: 'coords', x: 0, y: 0 }));
      ally.send(JSON.stringify({ type: 'coords', x: d, y: 0 }));
      enemy.send(JSON.stringify({ type: 'coords', x: d, y: 0 }));
      await wait(200);
    }
    const pv = await volumesFor(true);
    samples.push({ d, ally: pv.Ally, enemy: pv.Enemy });
    console.log(String(d).padEnd(6), show(pv.Ally).padEnd(11), show(pv.Enemy));
  }

  // --- derive the three constants -----------------------------------------
  const audible = samples.filter((s) => s.enemy !== undefined);
  const faded = audible.filter((s) => s.enemy < 1);
  const plateau = audible.filter((s) => s.enemy === 1);

  const cutoffLo = audible.length ? audible[audible.length - 1].d : null;
  const cutoffHi = samples.find((s) => s.enemy === undefined)?.d ?? null;
  const nearLo = plateau.length ? plateau[plateau.length - 1].d : null;
  const nearHi = faded.length ? faded[0].d : null;

  console.log('\ncut-off      between', cutoffLo, 'and', cutoffHi);
  console.log('fade starts  between', nearLo, 'and', nearHi);

  // Fit `v = 1 - ((d - lo) / (hi - lo))²` by least squares on the faded samples:
  // sqrt(1-v) is linear in d, so a straight-line fit gives both endpoints.
  if (faded.length >= 2) {
    const xs = faded.map((s) => s.d);
    const ys = faded.map((s) => Math.sqrt(1 - s.enemy));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const slope = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0) /
      xs.reduce((acc, x) => acc + (x - mx) ** 2, 0);
    const intercept = my - slope * mx;
    const lo = -intercept / slope;      // sqrt(1-v) = 0
    const hi = (1 - intercept) / slope; // sqrt(1-v) = 1
    console.log('\nfitted curve: v = 1 - ((d - ' + lo.toFixed(1) + ') / ' +
      (hi - lo).toFixed(1) + ')^2   (full volume below ' + lo.toFixed(0) +
      ', silence at ' + hi.toFixed(0) + ')');
    const worst = Math.max(...faded.map((s) =>
      Math.abs((1 - ((s.d - lo) / (hi - lo)) ** 2) - s.enemy)));
    console.log('worst residual:', worst.toExponential(2));
  }

  // --- allyProximity ------------------------------------------------------
  const withFlag = await volumesFor(true);
  const without = await volumesFor(false);
  console.log('\nallyProximity=true  -> Ally=' + show(withFlag.Ally));
  console.log('allyProximity=false -> Ally=' + show(without.Ally));
  const honoured = withFlag.Ally === undefined || withFlag.Ally < 1;
  console.log(honoured
    ? 'VERDICT: server HONOURS allyProximity.'
    : 'VERDICT: server IGNORES allyProximity — teammates cannot be faded by distance.');
} catch (err) {
  console.error('PROBE FAILED:', err?.message || err);
  process.exitCode = 1;
} finally {
  for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
}
