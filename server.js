'use strict';

const WebSocket = require('ws');
const crypto    = require('crypto');
const http      = require('http');

const PORT           = process.env.PORT || 3001;
const ROUND_DURATION = 60;
const REVEAL_PAUSE   = 8;
const TOTAL          = 100;

let roundId = 0;

function makeRound() {
  const seed   = crypto.randomBytes(16).toString('hex');
  const secret = Math.floor(Math.random() * TOTAL);
  const hash   = crypto.createHash('sha256')
                       .update(`${seed}:${secret}`)
                       .digest('hex');
  roundId++;
  return {
    roundId, seed, secret, hash,
    positions: new Map(),
    fund:  0,
    timer: ROUND_DURATION,
    phase: 'betting',
  };
}

let game = makeRound();
let tickInterval = null;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Candor WebSocket server');
});

const wss = new WebSocket.Server({ server: httpServer });

let connId = 0;

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function startTick() {
  clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    game.timer--;
    broadcast({ type: 'timer', seconds: game.timer });
    if (game.timer <= 0) { clearInterval(tickInterval); endRound(); }
  }, 1000);
}

function endRound() {
  game.phase = 'reveal';
  const positions = [];
  game.positions.forEach((v, k) => positions.push({ position: k, bet: v.bet }));
  broadcast({ type: 'round_end', roundId: game.roundId, secret: game.secret,
              seed: game.seed, hash: game.hash, fund: game.fund, positions });
  setTimeout(() => {
    game = makeRound();
    broadcast({ type: 'round_start', roundId: game.roundId, hash: game.hash, timer: game.timer });
    startTick();
  }, REVEAL_PAUSE * 1000);
}

wss.on('connection', ws => {
  ws.cid = ++connId;
  console.log(`[WS] conn ${ws.cid} connected, total=${wss.clients.size}`);

  const positions = [];
  game.positions.forEach((v, k) => positions.push({ position: k, bet: v.bet }));
  send(ws, { type: 'game_state', roundId: game.roundId, hash: game.hash,
             timer: game.timer, phase: game.phase, fund: game.fund,
             playerCount: game.positions.size, positions });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'place_bet') {
      const pos = Number(msg.position);
      const bet = Number(msg.bet);

      if (game.phase !== 'betting') { send(ws, { type: 'bet_rejected', reason: 'Раунд уже завершён' }); return; }
      if (!Number.isInteger(pos) || pos < 0 || pos >= TOTAL) { send(ws, { type: 'bet_rejected', reason: 'Недопустимая позиция' }); return; }
      if (game.positions.has(pos)) { send(ws, { type: 'bet_rejected', reason: 'Позиция уже занята' }); return; }
      if (!Number.isFinite(bet) || bet < 1 || bet > 10000) { send(ws, { type: 'bet_rejected', reason: 'Недопустимый размер ставки (1–10000)' }); return; }

      let alreadyBet = false;
      game.positions.forEach(v => { if (v.connId === ws.cid) alreadyBet = true; });
      if (alreadyBet) { send(ws, { type: 'bet_rejected', reason: 'Вы уже сделали ставку в этом раунде' }); return; }

      game.positions.set(pos, { bet, connId: ws.cid });
      game.fund += bet;
      console.log(`[BET] conn=${ws.cid} pos=${pos} clients=${wss.clients.size}`);
      broadcast({ type: 'bet_placed', position: pos, bet,
                  playerCount: game.positions.size, fund: game.fund });
    }
  });

  ws.on('close', (code) => console.log(`[WS] conn ${ws.cid} disconnected code=${code}`));
  ws.on('error', err => console.error(`[WS] conn ${ws.cid} error:`, err.message));
});

httpServer.listen(PORT, () => {
  console.log(`Candor server started on port ${PORT}`);
  startTick();
});
