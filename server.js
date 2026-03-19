'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const CONDOR_API_BASE = process.env.CONDOR_API_BASE || 'https://ggcoin.tech/candor/api2/condor_profile.php';
const CONDOR_API_SECRET = process.env.CONDOR_API_SECRET || '';

const HEX_COUNT = 19;
const ROUND_DURATION = 60;
const REVEAL_PAUSE = 8000;

const BET_SIZES = [10, 50, 100, 500, 1000];
const MULTIPLIERS = [2, 3, 6];

const lobbies = new Map();
let connIdSeq = 0;

function getLobbyKey(betSize, multiplier) {
  return `${betSize}x${multiplier}`;
}

function winnerCountForMultiplier(multiplier) {
  return Math.floor(HEX_COUNT / multiplier);
}

function perWinnerAmount(betSize, multiplier) {
  const winnerCount = winnerCountForMultiplier(multiplier);
  const loserCount = HEX_COUNT - winnerCount;
  return betSize + Math.floor(loserCount * (betSize - 1) / winnerCount);
}

function generateWinningNumbers() {
  const arr = Array.from({ length: HEX_COUNT }, (_, i) => i + 1);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 9);
}

function makeLobby(betSize, multiplier) {
  const seed = crypto.randomBytes(16).toString('hex');
  const winningNumbers = generateWinningNumbers();
  const hash = crypto.createHash('sha256')
    .update(`${seed}:${winningNumbers.join(',')}`)
    .digest('hex');

  return {
    key: getLobbyKey(betSize, multiplier),
    betSize,
    multiplier,
    seed,
    winningNumbers,
    hash,
    positions: new Map(),
    pendingByConn: new Map(),
    phase: 'betting',
    roundId: crypto.randomBytes(4).toString('hex'),
    timer: ROUND_DURATION,
    settlementAttempts: 0,
  };
}

function getOrCreateLobby(betSize, multiplier) {
  const key = getLobbyKey(betSize, multiplier);
  if (!lobbies.has(key)) lobbies.set(key, makeLobby(betSize, multiplier));
  return lobbies.get(key);
}

function lobbyPositionsArr(lobby) {
  const arr = [];
  lobby.positions.forEach((value, hexNum) => {
    arr.push({ hexNum, isBot: value.isBot || false });
  });
  return arr;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcastToLobby(key, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.lobbyKey === key) {
      client.send(msg);
    }
  });
}

function pendingHexTaken(lobby, hexNum) {
  for (const pending of lobby.pendingByConn.values()) {
    if (pending.hexNum === hexNum) return true;
  }
  return false;
}

function hasActiveBetForConn(lobby, connId) {
  if (lobby.pendingByConn.has(connId)) return true;
  for (const value of lobby.positions.values()) {
    if (value.connId === connId) return true;
  }
  return false;
}

function hasActiveBetForTelegram(lobby, telegramId) {
  if (!telegramId) return false;
  for (const pending of lobby.pendingByConn.values()) {
    if (pending.telegramId === telegramId) return true;
  }
  for (const value of lobby.positions.values()) {
    if (value.telegramId === telegramId) return true;
  }
  return false;
}

async function postJson(url, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = { success: false, error: 'invalid_json_response' };
  }

  return { ok: response.ok, status: response.status, data };
}

async function callCondorApi(action, payload) {
  return postJson(`${CONDOR_API_BASE}?action=${encodeURIComponent(action)}`, payload);
}

async function callSignedCondorApi(action, payload) {
  if (!CONDOR_API_SECRET) {
    throw new Error('CONDOR_API_SECRET is not configured');
  }

  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', CONDOR_API_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  const response = await fetch(`${CONDOR_API_BASE}?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Condor-Timestamp': timestamp,
      'X-Condor-Signature': signature,
    },
    body,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = { success: false, error: 'invalid_json_response' };
  }

  return { ok: response.ok, status: response.status, data };
}

function toBetRejectReason(apiResponse) {
  const error = String(apiResponse?.data?.error || '');
  switch (error) {
    case 'insufficient_hex':
      return 'Недостаточно HEX';
    case 'hex_already_taken':
      return 'Хекс уже занят';
    case 'bet_already_exists':
      return 'Вы уже сделали ставку';
    case 'round_already_finalized':
      return 'Раунд уже завершён';
    case 'telegram_signature_invalid':
    case 'telegram_init_data_required':
    case 'telegram_init_data_invalid':
    case 'telegram_auth_date_expired':
      return 'Ошибка авторизации Telegram';
    default:
      return apiResponse?.data?.error || 'Не удалось принять ставку';
  }
}

async function reserveBetOnApi(lobby, ws, msg, hexNum) {
  const telegramInitData = String(msg.telegramInitData || '').trim();
  const telegramId = String(msg.telegramId || '').replace(/\D+/g, '');
  const displayName = String(msg.displayName || '').trim();
  const telegramNick = String(msg.telegramNick || '').trim();

  if (!telegramInitData || !telegramId) {
    return { success: false, reason: 'Требуется авторизация Telegram' };
  }

  const response = await callCondorApi('reserve_bet', {
    telegram_id: telegramId,
    telegram_init_data: telegramInitData,
    telegram_nick: telegramNick,
    display_name: displayName,
    round_id: lobby.roundId,
    lobby_key: lobby.key,
    bet_size: lobby.betSize,
    multiplier: lobby.multiplier,
    hex_num: hexNum,
    hash: lobby.hash,
  });

  if (!response.data?.success) {
    return {
      success: false,
      reason: toBetRejectReason(response),
      error: response.data?.error || 'reserve_bet_failed',
    };
  }

  return {
    success: true,
    telegramId: String(response.data.telegram_id || telegramId),
    hexBalance: Number(response.data.hex_balance || 0),
  };
}

async function finalizeRoundOnApi(lobby) {
  return callSignedCondorApi('finalize_round', {
    round_id: lobby.roundId,
    lobby_key: lobby.key,
    bet_size: lobby.betSize,
    multiplier: lobby.multiplier,
    seed: lobby.seed,
    hash: lobby.hash,
    winning_numbers: lobby.winningNumbers,
  });
}

async function settleAndRevealLobby(lobby) {
  if (lobby.phase !== 'settling') return;

  const hasRealPlayers = Array.from(lobby.positions.values()).some(value => !value.isBot);
  if (hasRealPlayers) {
    const result = await finalizeRoundOnApi(lobby).catch(error => ({
      ok: false,
      status: 0,
      data: { success: false, error: error?.message || 'finalize_round_failed' },
    }));

    if (!result.data?.success) {
      lobby.settlementAttempts += 1;
      const delay = Math.min(5000 * Math.max(1, lobby.settlementAttempts), 30000);
      console.error(`[SETTLE] lobby=${lobby.key} round=${lobby.roundId} failed: ${result.data?.error || result.status}`);
      setTimeout(() => settleAndRevealLobby(lobby), delay);
      return;
    }
  }

  lobby.phase = 'reveal';
  const winnerCount = winnerCountForMultiplier(lobby.multiplier);
  const winners = lobby.winningNumbers.slice(0, winnerCount);
  const perWinner = perWinnerAmount(lobby.betSize, lobby.multiplier);
  const fundGain = HEX_COUNT - winnerCount;

  console.log(`[DRAW] lobby=${lobby.key} winners=[${winners}] perWinner=${perWinner} round=${lobby.roundId}`);

  broadcastToLobby(lobby.key, {
    type: 'round_result',
    lobbyKey: lobby.key,
    roundId: lobby.roundId,
    winningNumbers: lobby.winningNumbers,
    winners,
    seed: lobby.seed,
    hash: lobby.hash,
    betSize: lobby.betSize,
    multiplier: lobby.multiplier,
    perWinner,
    fundGain,
    positions: lobbyPositionsArr(lobby),
  });

  setTimeout(() => {
    const nextLobby = makeLobby(lobby.betSize, lobby.multiplier);
    lobbies.set(lobby.key, nextLobby);
    broadcastToLobby(lobby.key, {
      type: 'new_round',
      lobbyKey: lobby.key,
      roundId: nextLobby.roundId,
      hash: nextLobby.hash,
      timer: nextLobby.timer,
    });
    console.log(`[NEW ROUND] lobby=${lobby.key} roundId=${nextLobby.roundId}`);
  }, REVEAL_PAUSE);
}

async function fillBotsAndDraw(lobby) {
  if (lobby.phase !== 'betting') return;
  for (let h = 1; h <= HEX_COUNT; h++) {
    if (!lobby.positions.has(h)) {
      lobby.positions.set(h, { connId: null, telegramId: null, isBot: true });
    }
  }
  lobby.phase = 'settling';
  await settleAndRevealLobby(lobby);
}

setInterval(() => {
  lobbies.forEach(lobby => {
    if (lobby.phase !== 'betting') return;
    lobby.timer -= 1;
    broadcastToLobby(lobby.key, { type: 'timer', lobbyKey: lobby.key, seconds: lobby.timer });
    if (lobby.timer <= 0) {
      void fillBotsAndDraw(lobby);
    }
  });
}, 1000);

const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'condor_index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', ws => {
  ws.cid = ++connIdSeq;
  ws.lobbyKey = null;
  ws.telegramId = null;

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 5000);

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join_lobby') {
      const betSize = Number(msg.betSize);
      const multiplier = Number(msg.multiplier);

      if (!BET_SIZES.includes(betSize) || !MULTIPLIERS.includes(multiplier)) {
        send(ws, { type: 'error', reason: 'Недопустимые параметры лобби' });
        return;
      }

      ws.lobbyKey = getLobbyKey(betSize, multiplier);
      const lobby = getOrCreateLobby(betSize, multiplier);

      send(ws, {
        type: 'lobby_state',
        lobbyKey: lobby.key,
        roundId: lobby.roundId,
        betSize: lobby.betSize,
        multiplier: lobby.multiplier,
        hash: lobby.hash,
        phase: lobby.phase,
        timer: lobby.timer,
        positions: lobbyPositionsArr(lobby),
        playerCount: lobby.positions.size,
        totalSlots: HEX_COUNT,
      });

      console.log(`[JOIN] conn=${ws.cid} lobby=${ws.lobbyKey} (${lobby.positions.size}/${HEX_COUNT})`);
      return;
    }

    if (msg.type === 'place_bet') {
      const lobbyKey = String(msg.lobbyKey || '');
      const hexNum = Number(msg.hexNum);
      const telegramId = String(msg.telegramId || '').replace(/\D+/g, '');

      if (!lobbyKey || !lobbies.has(lobbyKey)) {
        send(ws, { type: 'bet_rejected', reason: 'Лобби не найдено' });
        return;
      }

      const lobby = lobbies.get(lobbyKey);

      if (lobby.phase !== 'betting') {
        send(ws, { type: 'bet_rejected', lobbyKey, reason: 'Раунд уже завершён' });
        return;
      }
      if (!Number.isInteger(hexNum) || hexNum < 1 || hexNum > HEX_COUNT) {
        send(ws, { type: 'bet_rejected', lobbyKey, reason: 'Недопустимый номер хекса' });
        return;
      }
      if (lobby.positions.has(hexNum) || pendingHexTaken(lobby, hexNum)) {
        send(ws, { type: 'bet_rejected', lobbyKey, reason: 'Хекс уже занят' });
        return;
      }
      if (hasActiveBetForConn(lobby, ws.cid) || hasActiveBetForTelegram(lobby, telegramId)) {
        send(ws, { type: 'bet_rejected', lobbyKey, reason: 'Вы уже сделали ставку' });
        return;
      }

      lobby.pendingByConn.set(ws.cid, { hexNum, telegramId });
      try {
        const reserved = await reserveBetOnApi(lobby, ws, msg, hexNum);
        if (!reserved.success) {
          send(ws, { type: 'bet_rejected', lobbyKey, reason: reserved.reason || 'Ставка отклонена' });
          return;
        }

        ws.telegramId = reserved.telegramId;
        lobby.positions.set(hexNum, {
          connId: ws.cid,
          telegramId: reserved.telegramId,
          isBot: false,
        });

        send(ws, {
          type: 'bet_confirmed',
          lobbyKey,
          roundId: lobby.roundId,
          hexNum,
          hexBalance: reserved.hexBalance,
        });

        console.log(`[BET] conn=${ws.cid} tg=${reserved.telegramId} lobby=${lobbyKey} hex=${hexNum} (${lobby.positions.size}/${HEX_COUNT})`);

        broadcastToLobby(lobbyKey, {
          type: 'bet_placed',
          lobbyKey,
          hexNum,
          playerCount: lobby.positions.size,
          totalSlots: HEX_COUNT,
        });

        if (lobby.positions.size === HEX_COUNT) {
          void fillBotsAndDraw(lobby);
        }
      } catch (error) {
        console.error(`[BET] reserve failed lobby=${lobbyKey}:`, error?.message || error);
        send(ws, { type: 'bet_rejected', lobbyKey, reason: 'Сервер временно недоступен' });
      } finally {
        lobby.pendingByConn.delete(ws.cid);
      }
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    lobbies.forEach(lobby => {
      lobby.pendingByConn.delete(ws.cid);
    });
    console.log(`[WS] conn ${ws.cid} disconnected`);
  });

  ws.on('error', err => console.error(`[WS] conn ${ws.cid}:`, err.message));
});

httpServer.listen(PORT, () => {
  console.log('─────────────────────────────────────────────');
  console.log(`  Condor Lottery  →  http://localhost:${PORT}`);
  console.log(`  WebSocket       →  ws://localhost:${PORT}`);
  console.log(`  API Base        →  ${CONDOR_API_BASE}`);
  console.log(`  Lobbies         →  ${BET_SIZES.length * MULTIPLIERS.length}`);
  console.log('─────────────────────────────────────────────');
});
