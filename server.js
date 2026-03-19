'use strict';

const WebSocket = require('ws');
const crypto    = require('crypto');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

const PORT           = process.env.PORT || 3001;
const HEX_COUNT      = 19;    // positions per lobby
const ROUND_DURATION = 60;    // seconds of betting phase
const REVEAL_PAUSE   = 8000;  // ms before new round starts

const BET_SIZES   = [10, 50, 100, 500, 1000];
const MULTIPLIERS = [2, 3, 6];

// Winner counts per multiplier (fixed, since 19 is not divisible evenly)
const WINNER_COUNTS = { 2: 9, 3: 6, 6: 3 };

// ─── Math
// 19 positions total. 1 position's full bet → lottery fund (handled later).
// Remaining 18 positions are distributed: winnerCount get paid, rest are losers.
// Multiplier 2 → 9 winners,  9 losers from 18  → perWinner = betSize + floor(9  * betSize / 9)  = 2×
// Multiplier 3 → 6 winners, 12 losers from 18  → perWinner = betSize + floor(12 * betSize / 6)  = 3×
// Multiplier 6 → 3 winners, 15 losers from 18  → perWinner = betSize + floor(15 * betSize / 3)  = 6×
const DISTRIB_COUNT = 18; // positions whose bets are distributed (1 goes to fund)

// ─── Lobby state ───────────────────────────────────────────────────────────
// key = "100x3"  →  lobby object
const lobbies = new Map();

function getLobbyKey(betSize, multiplier) {
  return `${betSize}x${multiplier}`;
}

function generateWinningNumbers() {
  // Shuffle 1..HEX_COUNT, take first 9
  const arr = Array.from({ length: HEX_COUNT }, (_, i) => i + 1);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 9);
}

function makeLobby(betSize, multiplier) {
  const seed           = crypto.randomBytes(16).toString('hex');
  const winningNumbers = generateWinningNumbers();  // always 9
  const hash           = crypto.createHash('sha256')
    .update(`${seed}:${winningNumbers.join(',')}`)
    .digest('hex');
  return {
    key: getLobbyKey(betSize, multiplier),
    betSize,
    multiplier,
    seed,
    winningNumbers,   // hidden until reveal
    hash,             // committed to clients at round start
    positions: new Map(), // hexNum (1-19) → { connId, isBot }
    phase:   'betting',   // 'betting' | 'reveal'
    roundId: crypto.randomBytes(4).toString('hex'),
    timer:   ROUND_DURATION,
  };
}

function getOrCreateLobby(betSize, multiplier) {
  const key = getLobbyKey(betSize, multiplier);
  if (!lobbies.has(key)) lobbies.set(key, makeLobby(betSize, multiplier));
  return lobbies.get(key);
}

function lobbyPositionsArr(lobby) {
  const arr = [];
  lobby.positions.forEach((v, hexNum) =>
    arr.push({ hexNum, isBot: v.isBot || false })
  );
  return arr;
}

// ─── Bot fill + draw ───────────────────────────────────────────────────────
function fillBotsAndDraw(lobby) {
  if (lobby.phase !== 'betting') return;
  for (let h = 1; h <= HEX_COUNT; h++) {
    if (!lobby.positions.has(h))
      lobby.positions.set(h, { connId: null, isBot: true });
  }
  executeDraw(lobby);
}

// ─── Global tick (one interval drives all lobbies) ─────────────────────────
setInterval(() => {
  lobbies.forEach((lobby, key) => {
    if (lobby.phase !== 'betting') return;
    lobby.timer--;
    broadcastToLobby(key, { type: 'timer', lobbyKey: key, seconds: lobby.timer });
    if (lobby.timer <= 0) fillBotsAndDraw(lobby);
  });
}, 1000);

// ─── HTTP server ───────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'condor_index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ─── WebSocket server ──────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });
let connIdSeq = 0;

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcastToLobby(key, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.lobbyKey === key) c.send(msg);
  });
}

// ─── Draw execution ────────────────────────────────────────────────────────
function executeDraw(lobby) {
  if (lobby.phase !== 'betting') return;
  lobby.phase = 'reveal';

  const winnerCount = WINNER_COUNTS[lobby.multiplier];  // 9 | 6 | 3
  const loserCount  = DISTRIB_COUNT - winnerCount;
  const winners     = lobby.winningNumbers.slice(0, winnerCount);
  const perWinner   = lobby.betSize + Math.floor(loserCount * lobby.betSize / winnerCount);
  const fundGain    = lobby.betSize;  // 1 full position's bet to lottery fund

  console.log(`[DRAW] lobby=${lobby.key} winners=[${winners}] perWinner=${perWinner} fund+=${fundGain}`);

  broadcastToLobby(lobby.key, {
    type:           'round_result',
    lobbyKey:       lobby.key,
    roundId:        lobby.roundId,
    winningNumbers: lobby.winningNumbers,   // all 9 (for transparency)
    winners,                                // first N (per multiplier)
    seed:           lobby.seed,
    hash:           lobby.hash,
    betSize:        lobby.betSize,
    multiplier:     lobby.multiplier,
    perWinner,
    fundGain,
    positions:      lobbyPositionsArr(lobby),
  });

  // Reset lobby after reveal pause
  setTimeout(() => {
    const newLobby = makeLobby(lobby.betSize, lobby.multiplier);
    lobbies.set(lobby.key, newLobby);
    broadcastToLobby(lobby.key, {
      type:     'new_round',
      lobbyKey: lobby.key,
      roundId:  newLobby.roundId,
      hash:     newLobby.hash,
      timer:    newLobby.timer,
    });
    console.log(`[NEW ROUND] lobby=${lobby.key} roundId=${newLobby.roundId}`);
  }, REVEAL_PAUSE);
}

// ─── Connection handler ────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.cid      = ++connIdSeq;
  ws.lobbyKey = null;

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 5000);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── join_lobby ──────────────────────────────────────────────────────────
    if (msg.type === 'join_lobby') {
      const betSize    = Number(msg.betSize);
      const multiplier = Number(msg.multiplier);

      if (!BET_SIZES.includes(betSize) || !MULTIPLIERS.includes(multiplier)) {
        send(ws, { type: 'error', reason: 'Недопустимые параметры лобби' });
        return;
      }

      ws.lobbyKey = getLobbyKey(betSize, multiplier);
      const lobby = getOrCreateLobby(betSize, multiplier);

      send(ws, {
        type:        'lobby_state',
        lobbyKey:    lobby.key,
        betSize:     lobby.betSize,
        multiplier:  lobby.multiplier,
        hash:        lobby.hash,
        phase:       lobby.phase,
        timer:       lobby.timer,
        positions:   lobbyPositionsArr(lobby),
        playerCount: lobby.positions.size,
        totalSlots:  HEX_COUNT,
      });

      console.log(`[JOIN] conn=${ws.cid} lobby=${ws.lobbyKey} (${lobby.positions.size}/${HEX_COUNT})`);
      return;
    }

    // ── place_bet ───────────────────────────────────────────────────────────
    if (msg.type === 'place_bet') {
      const { lobbyKey } = msg;
      const hexNum = Number(msg.hexNum);

      if (!lobbyKey || !lobbies.has(lobbyKey)) {
        send(ws, { type: 'bet_rejected', reason: 'Лобби не найдено' });
        return;
      }
      const lobby = lobbies.get(lobbyKey);

      if (lobby.phase !== 'betting') {
        send(ws, { type: 'bet_rejected', lobbyKey, hexNum, reason: 'Раунд уже завершён' });
        return;
      }
      if (!Number.isInteger(hexNum) || hexNum < 1 || hexNum > HEX_COUNT) {
        send(ws, { type: 'bet_rejected', lobbyKey, hexNum, reason: 'Недопустимый номер хекса' });
        return;
      }
      if (lobby.positions.has(hexNum)) {
        send(ws, { type: 'bet_rejected', lobbyKey, hexNum, reason: 'Хекс уже занят' });
        return;
      }
      lobby.positions.set(hexNum, { connId: ws.cid });
      console.log(`[BET] conn=${ws.cid} lobby=${lobbyKey} hex=${hexNum} (${lobby.positions.size}/${HEX_COUNT})`);

      broadcastToLobby(lobbyKey, {
        type:        'bet_placed',
        lobbyKey,
        hexNum,
        playerCount: lobby.positions.size,
        totalSlots:  HEX_COUNT,
      });

      if (lobby.positions.size === HEX_COUNT) executeDraw(lobby);
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    console.log(`[WS] conn ${ws.cid} disconnected`);
  });
  ws.on('error', err => console.error(`[WS] conn ${ws.cid}:`, err.message));
});

// ─── Start ─────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`─────────────────────────────────────────────`);
  console.log(`  Condor Lottery  →  http://localhost:${PORT}`);
  console.log(`  WebSocket       →  ws://localhost:${PORT}`);
  console.log(`  Lobbies: ${BET_SIZES.length} bet sizes × ${MULTIPLIERS.length} multipliers = ${BET_SIZES.length * MULTIPLIERS.length}`);
  console.log(`─────────────────────────────────────────────`);
});
