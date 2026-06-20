const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ===== KART VERİTABANI =====
const CARDS = {
  yenicieri:  { name: 'Yeniçeri', cost: 3, hp: 200, damage: 30, speed: 1, range: 30, type: 'melee', count: 1 },
  kopek:      { name: 'Köpek',    cost: 2, hp: 80,  damage: 15, speed: 2.5, range: 25, type: 'melee', count: 3 },
  kedi:       { name: 'Kedi',     cost: 1, hp: 40,  damage: 10, speed: 3, range: 20, type: 'melee', count: 4 },
  kartal:     { name: 'Kartal',   cost: 4, hp: 120, damage: 25, speed: 2, range: 100, type: 'ranged', flying: true, count: 1 },
  okcu:       { name: 'Okçu',     cost: 3, hp: 90,  damage: 20, speed: 1, range: 120, type: 'ranged', count: 2 },
  robot:      { name: 'Robot',    cost: 5, hp: 300, damage: 40, speed: 0.8, range: 30, type: 'melee', count: 1 },
  kale:       { name: 'Kale',     cost: 4, hp: 250, damage: 35, speed: 0, range: 110, type: 'building', count: 1 },
  ciftci:     { name: 'Çiftçi',   cost: 2, hp: 70,  damage: 8,  speed: 1.5, range: 25, type: 'melee', count: 2 }
};

const ALL_CARD_KEYS = Object.keys(CARDS);

// ===== ODA YÖNETİMİ =====
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function randomDeck() {
  const shuffled = [...ALL_CARD_KEYS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 5);
}

function createInitialGameState(p1Id, p2Id) {
  return {
    players: {
      [p1Id]: { 
        hand: randomDeck(), elixir: 5, towerHp: 1000, kingHp: 1500
      },
      [p2Id]: { 
        hand: randomDeck(), elixir: 5, towerHp: 1000, kingHp: 1500
      }
    },
    units: [], // {id, owner, cardKey, x, y, hp, target}
    time: 180, // 3 dakika
    started: Date.now()
  };
}

let unitIdCounter = 1;

io.on('connection', (socket) => {

  socket.on('createRoom', () => {
    const code = generateRoomCode();
    rooms[code] = { players: [socket.id], gameState: null, interval: null };
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('roomCreated', { code });
  });

  socket.on('joinRoom', (code) => {
    const room = rooms[code];
    if (!room) { socket.emit('errorMsg', 'Oda bulunamadı'); return; }
    if (room.players.length >= 2) { socket.emit('errorMsg', 'Oda dolu'); return; }

    room.players.push(socket.id);
    socket.join(code);
    socket.data.roomCode = code;

    const [p1, p2] = room.players;
    room.gameState = createInitialGameState(p1, p2);

    io.to(p1).emit('gameStart', { 
      you: p1, opponent: p2, hand: room.gameState.players[p1].hand, cards: CARDS 
    });
    io.to(p2).emit('gameStart', { 
      you: p2, opponent: p1, hand: room.gameState.players[p2].hand, cards: CARDS 
    });

    startGameLoop(code);
  });

  socket.on('deployUnit', ({ cardKey, x, y }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.gameState) return;
    const gs = room.gameState;
    const player = gs.players[socket.id];
    const card = CARDS[cardKey];
    if (!card) return;
    if (player.elixir < card.cost) return;
    if (!player.hand.includes(cardKey)) return;

    player.elixir -= card.cost;

    // Elden kaldır, yeni kart ekle (deste döngüsü)
    const idx = player.hand.indexOf(cardKey);
    player.hand.splice(idx, 1);
    const newCard = ALL_CARD_KEYS[Math.floor(Math.random() * ALL_CARD_KEYS.length)];
    player.hand.push(newCard);

    const spawnCount = card.count || 1;
    for (let i = 0; i < spawnCount; i++) {
      gs.units.push({
        id: unitIdCounter++,
        owner: socket.id,
        cardKey,
        x: x + (i * 20 - (spawnCount-1)*10),
        y: y,
        hp: card.hp,
        maxHp: card.hp,
        targetId: null
      });
    }

    io.to(code).emit('handUpdate', { playerId: socket.id, hand: player.hand });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (code && rooms[code]) {
      io.to(code).emit('opponentLeft');
      if (rooms[code].interval) clearInterval(rooms[code].interval);
      delete rooms[code];
    }
  });
});

// ===== OYUN DÖNGÜSÜ (SAVAŞ MANTIĞI) =====
function startGameLoop(code) {
  const room = rooms[code];
  const TICK_MS = 100;

  room.interval = setInterval(() => {
    const gs = room.gameState;
    if (!gs) return;

    // İksir üretimi
    for (const pid in gs.players) {
      const p = gs.players[pid];
      p.elixir = Math.min(10, p.elixir + 0.1); // ~1 iksir/saniye
    }

    // Birim hareketi ve savaş
    for (const unit of gs.units) {
      if (unit.hp <= 0) continue;
      const card = CARDS[unit.cardKey];

      // Hedef bul (en yakın düşman birim ya da kule)
      let nearestDist = Infinity;
      let nearestTarget = null;

      for (const other of gs.units) {
        if (other.owner === unit.owner || other.hp <= 0) continue;
        const d = Math.hypot(other.x - unit.x, other.y - unit.y);
        if (d < nearestDist) { nearestDist = d; nearestTarget = { type: 'unit', ref: other }; }
      }

      // Düşman kuleye mesafe (basitleştirilmiş: y ekseninde karşı tarafın kale konumu)
      const enemyTowerY = unit.owner === Object.keys(gs.players)[0] ? 0 : 600;
      const towerDist = Math.abs(enemyTowerY - unit.y);
      if (towerDist < nearestDist || !nearestTarget) {
        nearestDist = towerDist;
        nearestTarget = { type: 'tower', y: enemyTowerY };
      }

      if (nearestDist <= card.range) {
        // Saldır
        if (!unit.cooldown || unit.cooldown <= 0) {
          if (nearestTarget.type === 'unit') {
            nearestTarget.ref.hp -= card.damage;
          } else {
            const ownerIds = Object.keys(gs.players);
            const enemyId = ownerIds.find(id => id !== unit.owner);
            if (enemyId) gs.players[enemyId].towerHp -= card.damage;
          }
          unit.cooldown = 10; // tick sayısı
        } else {
          unit.cooldown--;
        }
      } else if (card.speed > 0) {
        // Hedefe doğru hareket et
        const dirY = unit.owner === Object.keys(gs.players)[0] ? 1 : -1;
        unit.y += dirY * card.speed;
      }
    }

    gs.units = gs.units.filter(u => u.hp > 0);

    gs.time -= TICK_MS / 1000;

    io.to(code).emit('stateUpdate', {
      units: gs.units,
      elixirs: Object.fromEntries(Object.entries(gs.players).map(([id, p]) => [id, p.elixir])),
      towerHps: Object.fromEntries(Object.entries(gs.players).map(([id, p]) => [id, p.towerHp])),
      time: Math.max(0, Math.floor(gs.time))
    });

    if (gs.time <= 0) {
      clearInterval(room.interval);
      const ids = Object.keys(gs.players);
      const winner = gs.players[ids[0]].towerHp > gs.players[ids[1]].towerHp ? ids[0] : ids[1];
      io.to(code).emit('gameOver', { winner });
    }

  }, TICK_MS);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Türk Royale sunucusu çalışıyor: ' + PORT));
