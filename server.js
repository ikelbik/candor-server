'use strict';

const WebSocket = require('ws');
const crypto    = require('crypto');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

const PORT           = process.env.PORT || 3001;
const HEX_COUNT      = 18;    // positions per lobby
const ROUND_DURATION = 60;    // seconds of betting phase
const REVEAL_PAUSE   = 8000;  // ms before new round starts

const BET_SIZES   = [5, 10, 25, 50, 100];
const MULTIPLIERS = [2, 3, 6];

// Winner counts per multiplier for the 18 playable hexes.
const WINNER_COUNTS = { 2: 9, 3: 6, 6: 3 };

function loadRoundSecretFromPhpConfig() {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'config_candor.php'),
    path.resolve(__dirname, '..', '..', '..', '..', 'config_candor.php'),
    path.resolve(__dirname, 'config_candor.php'),
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf8');
      const match = raw.match(/define\s*\(\s*['"]CONDOR_ROUND_SECRET['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i);
      if (match && match[1]) {
        return match[1];
      }
    } catch {}
  }
  return '';
}

const ROUND_SECRET = process.env.CONDOR_ROUND_SECRET || loadRoundSecretFromPhpConfig();
if (!ROUND_SECRET) {
  throw new Error('CONDOR_ROUND_SECRET is required. Refusing to start with an empty round secret.');
}

// ─── Math
// All 18 positions are playable and distributed between winners and losers.
// Multiplier 2 → 9 winners,  9 losers from 18  → perWinner = betSize + floor(9  * betSize / 9)  = 2×
// Multiplier 3 → 6 winners, 12 losers from 18  → perWinner = betSize + floor(12 * betSize / 6)  = 3×
// Multiplier 6 → 3 winners, 15 losers from 18  → perWinner = betSize + floor(15 * betSize / 3)  = 6×
const DISTRIB_COUNT = 18;

// ─── Lobby state ───────────────────────────────────────────────────────────
// key = "100x3"  →  lobby object
const lobbies = new Map();

function getLobbyKey(betSize, multiplier) {
  return `${betSize}x${multiplier}`;
}

function cryptoRandInt(max) {
  // Rejection-sampling: ensures uniform distribution, no modulo bias
  const needed = Math.ceil(Math.log2(max + 1));
  const byteCount = Math.ceil(needed / 8);
  const mask = (1 << needed) - 1;
  let val;
  do {
    val = crypto.randomBytes(byteCount).readUIntBE(0, byteCount) & mask;
  } while (val > max);
  return val;
}

function generateWinningNumbers() {
  // Fisher-Yates shuffle with CSPRNG — crypto.randomBytes() only
  const arr = Array.from({ length: HEX_COUNT }, (_, i) => i + 1);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = cryptoRandInt(i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 9);
}

function makeLobby(betSize, multiplier) {
  const seed           = crypto.randomBytes(16).toString('hex');
  const winningNumbers = generateWinningNumbers();  // always 9
  // Sort numbers for hash so PHP can verify without caring about order
  const sortedNums     = [...winningNumbers].sort((a, b) => a - b);
  const hash           = crypto.createHash('sha256')
    .update(`${seed}:${sortedNums.join(',')}`)
    .digest('hex');
  const sig            = crypto.createHmac('sha256', ROUND_SECRET)
    .update(hash)
    .digest('hex');
  return {
    key: getLobbyKey(betSize, multiplier),
    betSize,
    multiplier,
    seed,
    winningNumbers,   // hidden until reveal
    hash,             // committed to clients at round start
    sig,              // HMAC signature — proves hash came from this server
    positions: new Map(), // hexNum (1-18) → { connId, isBot }
    phase:   'betting',   // 'betting' | 'reveal'
    roundId: crypto.randomBytes(8).toString('hex'),
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

function getPlayerKey(ws, rawPlayerId = null) {
  const cleaned = String(rawPlayerId ?? ws.playerId ?? '').replace(/\D+/g, '');
  return cleaned ? `tg:${cleaned}` : `conn:${ws.cid}`;
}

function base64UrlDecode(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function verifyBetTicket(token, lobby, hexNum) {
  if (!ROUND_SECRET) {
    return { ok: false, reason: 'server_secret_missing' };
  }
  if (typeof token !== 'string') {
    return { ok: false, reason: 'ticket_missing' };
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'ticket_format_invalid' };
  }
  const payloadB64 = parts[0];
  const providedSig = parts[1];
  const expectedSig = crypto.createHmac('sha256', ROUND_SECRET)
    .update(payloadB64)
    .digest('hex');
  if (providedSig.length !== expectedSig.length) {
    return { ok: false, reason: 'ticket_signature_invalid' };
  }
  if (!crypto.timingSafeEqual(Buffer.from(providedSig, 'utf8'), Buffer.from(expectedSig, 'utf8'))) {
    return { ok: false, reason: 'ticket_signature_invalid' };
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return { ok: false, reason: 'ticket_payload_invalid' };
  }

  const tid = String(payload?.tid ?? '').replace(/\D+/g, '');
  const rid = String(payload?.rid ?? '');
  const lk = String(payload?.lk ?? '');
  const ticketHex = Number(payload?.hex);
  const exp = Number(payload?.exp ?? 0);
  const version = Number(payload?.v ?? 0);
  const now = Math.floor(Date.now() / 1000);

  if (!tid) return { ok: false, reason: 'ticket_player_missing' };
  if (version !== 1) return { ok: false, reason: 'ticket_version_invalid' };
  if (rid !== lobby.roundId) {
    return { ok: false, reason: 'ticket_round_mismatch', detail: { ticketRoundId: rid, lobbyRoundId: lobby.roundId } };
  }
  if (lk !== lobby.key) {
    return { ok: false, reason: 'ticket_lobby_mismatch', detail: { ticketLobbyKey: lk, lobbyKey: lobby.key } };
  }
  if (!Number.isInteger(ticketHex) || ticketHex !== hexNum) {
    return { ok: false, reason: 'ticket_hex_mismatch', detail: { ticketHex: ticketHex, requestedHex: hexNum } };
  }
  if (!Number.isFinite(exp) || exp < now) {
    return { ok: false, reason: 'ticket_expired', detail: { exp, now } };
  }

  return { ok: true, telegramId: tid, playerKey: `tg:${tid}` };
}

function mapTicketRejectReason(result) {
  switch (result?.reason) {
    case 'server_secret_missing':
      return 'Сервер ставок не настроен';
    case 'ticket_round_mismatch':
      return 'Раунд уже сменился';
    case 'ticket_lobby_mismatch':
      return 'Лобби ставки изменилось';
    case 'ticket_hex_mismatch':
      return 'Подпись выдана для другого хекса';
    case 'ticket_expired':
      return 'Подтверждение ставки истекло';
    case 'ticket_signature_invalid':
      return 'Подпись ставки не прошла проверку';
    default:
      return 'Ставка не подтверждена';
  }
}

function countHumanPlayers(lobby) {
  const uniquePlayers = new Set();
  lobby.positions.forEach(v => {
    if (v?.isBot) return;
    const playerKey = typeof v?.playerKey === 'string' ? v.playerKey : '';
    if (playerKey) uniquePlayers.add(playerKey);
  });
  return uniquePlayers.size;
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
  const fundGain    = 0;

  console.log(`[DRAW] lobby=${lobby.key} winners=[${winners}] perWinner=${perWinner} fund+=${fundGain}`);

  broadcastToLobby(lobby.key, {
    type:           'round_result',
    lobbyKey:       lobby.key,
    roundId:        lobby.roundId,
    winningNumbers: lobby.winningNumbers,   // all 9 (for transparency + PHP verification)
    winners,                                // first N (per multiplier)
    seed:           lobby.seed,             // revealed so PHP can verify SHA256(seed:sortedNums)==hash
    hash:           lobby.hash,
    sig:            lobby.sig,
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
      sig:      newLobby.sig,
      timer:    newLobby.timer,
    });
    console.log(`[NEW ROUND] lobby=${lobby.key} roundId=${newLobby.roundId}`);
  }, REVEAL_PAUSE);
}

// ─── Connection rate limiting ──────────────────────────────────────────────
const MAX_CONNS_PER_IP  = 10;   // max simultaneous WS connections per IP
const MAX_MSG_BYTES     = 4096; // max incoming message size
const MSG_RATE_WINDOW   = 1000; // ms window for rate limiting messages
const MSG_RATE_MAX      = 20;   // max messages per window per connection

const connCountByIp = new Map(); // ip → count

// ─── Connection handler ────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';

  const currentCount = connCountByIp.get(ip) || 0;
  if (currentCount >= MAX_CONNS_PER_IP) {
    ws.close(1008, 'Too many connections');
    return;
  }
  connCountByIp.set(ip, currentCount + 1);

  ws.cid      = ++connIdSeq;
  ws.lobbyKey = null;
  ws.playerId = '';
  ws._ip      = ip;
  ws._msgCount = 0;
  ws._msgWindowStart = Date.now();

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 5000);

  ws.on('message', raw => {
    // Size guard
    if (Buffer.byteLength(raw) > MAX_MSG_BYTES) {
      ws.close(1009, 'Message too large');
      return;
    }
    // Rate limit guard
    const now = Date.now();
    if (now - ws._msgWindowStart > MSG_RATE_WINDOW) {
      ws._msgWindowStart = now;
      ws._msgCount = 0;
    }
    ws._msgCount++;
    if (ws._msgCount > MSG_RATE_MAX) {
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── join_lobby ──────────────────────────────────────────────────────────
    if (msg.type === 'join_lobby') {
      const betSize    = Number(msg.betSize);
      const multiplier = Number(msg.multiplier);
      ws.playerId = String(msg.playerId ?? '').replace(/\D+/g, '');

      if (!BET_SIZES.includes(betSize) || !MULTIPLIERS.includes(multiplier)) {
        send(ws, { type: 'error', reason: 'Недопустимые параметры лобби' });
        return;
      }

      ws.lobbyKey = getLobbyKey(betSize, multiplier);
      const lobby = getOrCreateLobby(betSize, multiplier);

      send(ws, {
        type:        'lobby_state',
        lobbyKey:    lobby.key,
        roundId:     lobby.roundId,
        betSize:     lobby.betSize,
        multiplier:  lobby.multiplier,
        hash:        lobby.hash,
        sig:         lobby.sig,
        phase:       lobby.phase,
        timer:       lobby.timer,
        positions:   lobbyPositionsArr(lobby),
        playerCount: countHumanPlayers(lobby),
        totalSlots:  HEX_COUNT,
      });

      console.log(`[JOIN] conn=${ws.cid} lobby=${ws.lobbyKey} players=${countHumanPlayers(lobby)} hexes=${lobby.positions.size}/${HEX_COUNT}`);
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
      const verifiedTicket = verifyBetTicket(msg.ticket, lobby, hexNum);
      if (!verifiedTicket?.ok) {
        console.warn('[BET_REJECTED]', JSON.stringify({
          lobbyKey,
          hexNum,
          reason: verifiedTicket?.reason || 'ticket_invalid',
          detail: verifiedTicket?.detail || null,
        }));
        send(ws, { type: 'bet_rejected', lobbyKey, hexNum, reason: mapTicketRejectReason(verifiedTicket) });
        return;
      }
      if (lobby.positions.has(hexNum)) {
        send(ws, { type: 'bet_rejected', lobbyKey, hexNum, reason: 'Хекс уже занят' });
        return;
      }
      ws.playerId = verifiedTicket.telegramId;
      lobby.positions.set(hexNum, { connId: ws.cid, playerKey: verifiedTicket.playerKey });
      console.log(`[BET] conn=${ws.cid} lobby=${lobbyKey} hex=${hexNum} players=${countHumanPlayers(lobby)} hexes=${lobby.positions.size}/${HEX_COUNT}`);

      broadcastToLobby(lobbyKey, {
        type:        'bet_placed',
        lobbyKey,
        hexNum,
        playerCount: countHumanPlayers(lobby),
        totalSlots:  HEX_COUNT,
      });

      if (lobby.positions.size === HEX_COUNT) executeDraw(lobby);
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    const remaining = (connCountByIp.get(ws._ip) || 1) - 1;
    if (remaining <= 0) connCountByIp.delete(ws._ip);
    else connCountByIp.set(ws._ip, remaining);
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
  if (!ROUND_SECRET) console.warn(`  ⚠ CONDOR_ROUND_SECRET not set — bet signatures are insecure!`);
  console.log(`─────────────────────────────────────────────`);
});
