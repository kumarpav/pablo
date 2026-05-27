const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Game constants ────────────────────────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const PEEK_MS = 3000;

function cardValue(r, s) {
  if (r === 'A') return 1;
  if (r === 'J') return 11;
  if (r === 'Q') return 12;
  if (r === 'K') return isRed(s) ? -1 : 13;
  return parseInt(r);
}
function specialAbility(r) {
  if (r === '7' || r === '8') return 'peek';
  if (r === '9' || r === '10') return 'spy';
  return null;
}
function isRed(s) { return s === '♥' || s === '♦'; }

function createDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, value: cardValue(r, s) });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function makeRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// ── Room store ────────────────────────────────────────────────────────────────
// rooms[code] = { code, host, players: [{id, name, hand, knownIndices, totalScore}],
//                 state: 'lobby'|'playing'|'round_end', game: {...} }
const rooms = {};

function getRoom(code) { return rooms[code]; }

function broadcastLobby(code) {
  const room = getRoom(code);
  if (!room) return;
  io.to(code).emit('lobby_update', {
    code,
    host: room.host,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    state: room.state
  });
}

// ── Game logic (server-authoritative) ────────────────────────────────────────
function initRound(room) {
  const deck = createDeck();
  const g = room.game;
  g.deck = deck;
  g.discard = [deck.pop()];
  g.drawnCard = null;
  g.phase = 'draw';
  g.pabloCalled = false;
  g.pabloCallerIdx = -1;
  g.lastRound = false;
  g.lastRoundTurnsLeft = 0;
  g.specialPending = null;
  g.currentPlayerIdx = ((room.game.round || 1) - 1) % room.players.length;
  g.peekQueue = []; // [{playerIdx, cardIdx, hideAt}]

  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    p.hand = [];
    for (let j = 0; j < 4; j++) p.hand.push({ ...deck.pop() });
    p.knownIndices = new Set([0, 3]);
  }
}

// Build the state snapshot sent to each player
// Cards in other players' hands are hidden unless temporarily revealed
function buildStateForPlayer(room, playerId) {
  const g = room.game;
  const myIdx = room.players.findIndex(p => p.id === playerId);
  const top = g.discard.length ? g.discard[g.discard.length - 1] : null;
  const now = Date.now();

  const players = room.players.map((p, i) => {
    const isMe = p.id === playerId;
    const hand = p.hand.map((card, ci) => {
      if (!card) return null;
      // Check if this card is in an active timed reveal
      const peek = g.peekQueue && g.peekQueue.find(pk => pk.playerIdx === i && pk.cardIdx === ci);
      const revealed = peek && peek.hideAt > now;
      if (isMe && revealed) return { ...card, revealed: true };
      if (isMe) return { hidden: true }; // own hidden card
      if (revealed) return { ...card, revealed: true }; // spy reveal
      return { hidden: true };
    });
    return {
      id: p.id,
      name: p.name,
      totalScore: p.totalScore,
      handSize: p.hand.filter(Boolean).length,
      hand,
      isMe,
      isCurrent: i === g.currentPlayerIdx
    };
  });

  // Round-end: reveal all
  if (g.phase === 'round_end') {
    for (let i = 0; i < room.players.length; i++) {
      players[i].hand = room.players[i].hand.map(c => c ? { ...c, revealed: true } : null);
    }
  }

  return {
    roomCode: room.code,
    round: g.round,
    state: room.state,
    phase: g.phase,
    currentPlayerIdx: g.currentPlayerIdx,
    currentPlayerName: room.players[g.currentPlayerIdx]?.name,
    myIdx,
    players,
    discardTop: top,
    drawnCard: g.currentPlayerIdx === myIdx ? g.drawnCard : (g.drawnCard ? { hidden: false, hasDrawn: true } : null),
    pabloCalled: g.pabloCalled,
    pabloCallerIdx: g.pabloCallerIdx,
    lastRound: g.lastRound,
    specialPending: g.currentPlayerIdx === myIdx ? g.specialPending : null,
    scoreLimit: room.scoreLimit,
    roundResults: g.roundResults || null
  };
}

function broadcastState(room) {
  for (const p of room.players) {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.emit('game_state', buildStateForPlayer(room, p.id));
  }
}

function schedulePeekHide(room, playerIdx, cardIdx) {
  const hideAt = Date.now() + PEEK_MS;
  if (!room.game.peekQueue) room.game.peekQueue = [];
  // remove existing
  room.game.peekQueue = room.game.peekQueue.filter(pk => !(pk.playerIdx === playerIdx && pk.cardIdx === cardIdx));
  room.game.peekQueue.push({ playerIdx, cardIdx, hideAt });
  broadcastState(room);
  setTimeout(() => {
    if (!room || !room.game) return;
    room.game.peekQueue = (room.game.peekQueue || []).filter(pk => !(pk.playerIdx === playerIdx && pk.cardIdx === cardIdx));
    broadcastState(room);
  }, PEEK_MS);
}

function endTurn(room) {
  const g = room.game;
  if (g.lastRound) {
    g.lastRoundTurnsLeft--;
    if (g.lastRoundTurnsLeft <= 0) { endRound(room); return; }
  }
  g.currentPlayerIdx = (g.currentPlayerIdx + 1) % room.players.length;
  if (g.currentPlayerIdx === g.pabloCallerIdx && g.lastRound) { endRound(room); return; }
  g.phase = 'draw';
  broadcastState(room);
}

function endRound(room) {
  const g = room.game;
  g.phase = 'round_end';
  g.peekQueue = [];

  const scores = room.players.map((p, i) => ({
    name: p.name,
    handTotal: p.hand.reduce((s, c) => s + (c ? c.value : 0), 0),
    idx: i
  }));
  const minScore = Math.min(...scores.map(s => s.handTotal));

  const results = [];
  for (let i = 0; i < room.players.length; i++) {
    let pts = scores[i].handTotal;
    const isPenalty = i === g.pabloCallerIdx && pts !== minScore;
    if (isPenalty) pts += 10;
    room.players[i].totalScore += pts;
    results.push({
      name: room.players[i].name,
      handTotal: scores[i].handTotal,
      roundPts: pts,
      totalScore: room.players[i].totalScore,
      isWinner: scores[i].handTotal === minScore,
      isPenalty,
      isPabloCaller: i === g.pabloCallerIdx,
      hand: room.players[i].hand.filter(Boolean).map(c => `${c.rank}${c.suit}`)
    });
  }
  g.roundResults = results;
  room.state = 'round_end';
  broadcastState(room);
}

// ── Snap logic ────────────────────────────────────────────────────────────────
function handleSnap(room, playerIdx, cardIdx) {
  const g = room.game;
  const top = g.discard.length ? g.discard[g.discard.length - 1] : null;
  if (!top) return { ok: false, msg: 'No discard yet' };
  const card = room.players[playerIdx].hand[cardIdx];
  if (!card) return { ok: false, msg: 'No card there' };

  // remove from peek queue
  if (g.peekQueue) g.peekQueue = g.peekQueue.filter(pk => !(pk.playerIdx === playerIdx && pk.cardIdx === cardIdx));

  const match = card.rank === top.rank;
  if (match) {
    g.discard.push(card);
    room.players[playerIdx].hand[cardIdx] = null;
    room.players[playerIdx].knownIndices.delete(cardIdx);
    broadcastState(room);
    io.to(room.code).emit('snap_result', { playerName: room.players[playerIdx].name, card: `${card.rank}${card.suit}`, success: true });
    return { ok: true };
  } else {
    if (!g.deck.length) reshuffleDeck(g);
    const pen = g.deck.pop();
    const ni = room.players[playerIdx].hand.indexOf(null);
    if (ni >= 0) room.players[playerIdx].hand[ni] = pen;
    else room.players[playerIdx].hand.push(pen);
    broadcastState(room);
    io.to(room.code).emit('snap_result', { playerName: room.players[playerIdx].name, card: `${card.rank}${card.suit}`, success: false, penalty: true });
    return { ok: true };
  }
}

function reshuffleDeck(g) {
  const top = g.discard.pop();
  g.deck = [...g.discard];
  g.discard = top ? [top] : [];
  for (let i = g.deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [g.deck[i], g.deck[j]] = [g.deck[j], g.deck[i]];
  }
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Create lobby
  socket.on('create_lobby', ({ name, scoreLimit }) => {
    let code;
    do { code = makeRoomCode(); } while (rooms[code]);
    rooms[code] = {
      code,
      host: socket.id,
      scoreLimit: scoreLimit || 100,
      state: 'lobby',
      players: [{ id: socket.id, name: name || 'Player 1', hand: [], knownIndices: new Set(), totalScore: 0 }],
      game: { round: 1 }
    };
    socket.join(code);
    socket.data.roomCode = code;
    broadcastLobby(code);
  });

  // Join lobby
  socket.on('join_lobby', ({ code, name }) => {
    const room = getRoom(code.toUpperCase());
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.state !== 'lobby') { socket.emit('error', 'Game already started'); return; }
    if (room.players.length >= 6) { socket.emit('error', 'Room is full (max 6)'); return; }
    room.players.push({ id: socket.id, name: name || `Player ${room.players.length + 1}`, hand: [], knownIndices: new Set(), totalScore: 0 });
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    broadcastLobby(code.toUpperCase());
  });

  // Start game (host only)
  socket.on('start_game', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 2) { socket.emit('error', 'Need at least 2 players'); return; }
    room.state = 'playing';
    room.game = { round: 1 };
    initRound(room);
    // Show initial peek cards 0 and 3 for each player
    for (let i = 0; i < room.players.length; i++) {
      schedulePeekHide(room, i, 0);
      schedulePeekHide(room, i, 3);
    }
    broadcastState(room);
    io.to(code).emit('game_started');
  });

  // Draw from deck
  socket.on('draw_deck', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || room.state !== 'playing') return;
    const g = room.game;
    const myIdx = room.players.findIndex(p => p.id === socket.id);
    if (myIdx !== g.currentPlayerIdx || g.phase !== 'draw') return;
    if (!g.deck.length) reshuffleDeck(g);
    g.drawnCard = g.deck.pop();
    g.phase = 'act';
    broadcastState(room);
  });

  // Discard drawn card (may trigger special)
  socket.on('discard_drawn', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const g = room.game;
    const myIdx = room.players.findIndex(p => p.id === socket.id);
    if (myIdx !== g.currentPlayerIdx || !g.drawnCard) return;
    const ability = specialAbility(g.drawnCard.rank);
    if (ability) {
      g.specialPending = { type: ability, card: g.drawnCard };
      g.phase = `special-${ability}`;
      g.drawnCard = null;
      broadcastState(room);
    } else {
      g.discard.push(g.drawnCard);
      g.drawnCard = null;
      g.phase = 'draw';
      broadcastState(room);
      endTurn(room);
    }
  });

  // Swap drawn card with hand card
  socket.on('swap_card', ({ cardIdx }) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const g = room.game;
    const myIdx = room.players.findIndex(p => p.id === socket.id);
    if (myIdx !== g.currentPlayerIdx || g.phase !== 'act' || !g.drawnCard) return;
    const old = room.players[myIdx].hand[cardIdx];
    room.players[myIdx].hand[cardIdx] = { ...g.drawnCard };
    room.players[myIdx].knownIndices.add(cardIdx);
    g.discard.push(old);
    g.drawnCard = null;
    g.phase = 'draw';
    schedulePeekHide(room, myIdx, cardIdx);
    endTurn(room);
  });

  // Special: peek own card
  socket.on('special_peek', ({ cardIdx }) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const g = room.game;
    const myIdx = room.players.findIndex(p => p.id === socket.id);
    if (myIdx !== g.currentPlayerIdx || g.phase !== 'special-peek') return;
    if (g.specialPending) g.discard.push(g.specialPending.card);
    room.players[myIdx].knownIndices.add(cardIdx);
    g.specialPending = null;
    g.phase = 'draw';
    schedulePeekHide(room, myIdx, cardIdx);
    endTurn(room);
  });

  // Special: spy opponent card
  socket.on('special_spy', ({ targetPlayerIdx, cardIdx }) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const g = room.game;
    const myIdx = room.players.findIndex(p => p.id === socket.id);
    if (myIdx !== g.currentPlayerIdx || g.phase !== 'special-spy') return;
    if (g.specialPending) g.discard.push(g.specialPending.card);
    g.specialPending = null;
    g.phase = 'draw';
    schedulePeekHide(room, targetPlayerIdx, cardIdx);
    endTurn(room);
  });

  // Special: swap with opponent
  socket.on('special_swap', ({ myCardIdx, targetPlayerIdx, targetCardIdx }) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const g = room.game;
    const myIdx = room.players.findIndex(p => p.id === socket.id);
    if (myIdx !== g.currentPlayerIdx || g.phase !== 'special-swap') return;
    const myCard = room.players[myIdx].hand[myCardIdx];
    const theirCard = room.players[targetPlayerIdx].hand[targetCardIdx];
    room.players[myIdx].hand[myCardIdx] = theirCard;
    room.players[targetPlayerIdx].hand[targetCardIdx] = myCard;
    room.players[myIdx].knownIndices.delete(myCardIdx);
    if (g.specialPending) g.discard.push(g.specialPending.card);
    g.specialPending = null;
    g.phase = 'draw';
    broadcastState(room);
    endTurn(room);
  });

  // Cancel special
  socket.on('special_cancel', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const g = room.game;
    const myIdx = room.players.findIndex(p => p.id === socket.id);
    if (myIdx !== g.currentPlayerIdx) return;
    if (g.specialPending) g.discard.push(g.specialPending.card);
    g.specialPending = null;
    g.phase = 'draw';
    broadcastState(room);
    endTurn(room);
  });

  // Call Pablo
  socket.on('call_pablo', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const g = room.game;
    const myIdx = room.players.findIndex(p => p.id === socket.id);
    if (myIdx !== g.currentPlayerIdx || g.pabloCalled || g.phase !== 'draw') return;
    g.pabloCalled = true;
    g.pabloCallerIdx = myIdx;
    g.lastRound = true;
    g.lastRoundTurnsLeft = room.players.length - 1;
    io.to(code).emit('pablo_called', { playerName: room.players[myIdx].name });
    broadcastState(room);
    endTurn(room);
  });

  // Snap attempt
  socket.on('snap', ({ targetPlayerIdx, cardIdx }) => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || room.state !== 'playing') return;
    handleSnap(room, targetPlayerIdx, cardIdx);
  });

  // Next round
  socket.on('next_round', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    const gameOver = room.players.some(p => p.totalScore >= room.scoreLimit);
    if (gameOver) return;
    room.game.round = (room.game.round || 1) + 1;
    room.state = 'playing';
    initRound(room);
    for (let i = 0; i < room.players.length; i++) {
      schedulePeekHide(room, i, 0);
      schedulePeekHide(room, i, 3);
    }
    broadcastState(room);
  });

  // Play again (full reset)
  socket.on('play_again', () => {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room || room.host !== socket.id) return;
    for (const p of room.players) p.totalScore = 0;
    room.game = { round: 1 };
    room.state = 'lobby';
    broadcastLobby(code);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) { delete rooms[code]; return; }
    if (room.host === socket.id) room.host = room.players[0].id;
    if (room.state === 'lobby') {
      broadcastLobby(code);
    } else {
      io.to(code).emit('player_left', { name: socket.data.playerName || 'A player' });
      // If it was their turn, advance
      if (room.game && room.game.currentPlayerIdx >= room.players.length) {
        room.game.currentPlayerIdx = 0;
      }
      broadcastState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Pablo server running on port ${PORT}`));
