// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // in production, set this to your Netlify frontend URL
    methods: ["GET", "POST"]
  }
});

// ---- Game state in memory ----
const rooms = {};

// Utilities
function createDeck() {
  const suits = ['S', 'H', 'D', 'C']; // Spades, Hearts, Diamonds, Clubs
  const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const deck = [];
  for (const s of suits) {
    for (const r of ranks) {
      deck.push(r + s);
    }
  }
  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function dealCards() {
  const deck = createDeck();
  return {
    N: deck.slice(0, 13),
    E: deck.slice(13, 26),
    S: deck.slice(26, 39),
    W: deck.slice(39, 52)
  };
}

function getNextSeat(seat) {
  const order = ['N', 'E', 'S', 'W'];
  const idx = order.indexOf(seat);
  return order[(idx + 1) % 4];
}

// Socket.io logic
io.on('connection', (socket) => {
  console.log('New client connected', socket.id);

  socket.on('join_room', ({ roomId, name }) => {
    console.log(`${name} joining room ${roomId}`);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: {},
        seats: { N: null, E: null, S: null, W: null },
        phase: 'waiting', // 'waiting' | 'playing'
        trick: null
      };
    }

    const room = rooms[roomId];

    // Assign seat
    let assignedSeat = null;
    for (const seat of ['N', 'E', 'S', 'W']) {
      if (!room.seats[seat]) {
        assignedSeat = seat;
        room.seats[seat] = socket.id;
        break;
      }
    }

    if (!assignedSeat) {
      socket.emit('room_full');
      return;
    }

    room.players[socket.id] = {
      name,
      seat: assignedSeat,
      hand: []
    };

    socket.join(roomId);

    // broadcast room state (public info)
    io.to(roomId).emit('room_state', {
      seats: room.seats,
      players: Object.fromEntries(
        Object.entries(room.players).map(([id, p]) => [id, { name: p.name, seat: p.seat }])
      ),
      phase: room.phase
    });

    // Auto-start when all 4 seats filled
    const seatIds = Object.values(room.seats);
    if (seatIds.every((id) => id !== null) && room.phase === 'waiting') {
      startGame(roomId);
    }
  });

  socket.on('play_card', ({ roomId, card }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;
    const player = room.players[socket.id];
    if (!player) return;

    const seat = player.seat;
    const trick = room.trick;
    if (!trick) return;

    const currentSeat = trick.order[trick.currentIndex];

    if (seat !== currentSeat) {
      socket.emit('error_message', 'Not your turn!');
      return;
    }

    const idx = player.hand.indexOf(card);
    if (idx === -1) {
      socket.emit('error_message', 'You do not have this card.');
      return;
    }

    // Play the card
    player.hand.splice(idx, 1);
    trick.cards[seat] = card;
    trick.currentIndex++;

    broadcastGameState(roomId);

    // If trick complete (4 cards)
    if (trick.currentIndex >= 4) {
      const nextLead = getNextSeat(trick.leadSeat);
      room.trick = {
        leadSeat: nextLead,
        cards: { N: null, E: null, S: null, W: null },
        order: ['N', 'E', 'S', 'W'],
        currentIndex: 0
      };
      io.to(roomId).emit('new_trick', { leadSeat: nextLead });
      broadcastGameState(roomId);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected', socket.id);

    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        const seat = room.players[socket.id].seat;
        delete room.players[socket.id];
        room.seats[seat] = null;

        room.phase = 'waiting';
        room.trick = null;

        io.to(roomId).emit('room_state', {
          seats: room.seats,
          players: Object.fromEntries(
            Object.entries(room.players).map(([id, p]) => [id, { name: p.name, seat: p.seat }])
          ),
          phase: room.phase
        });
      }
    }
  });
});

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const hands = dealCards();
  for (const [seat, socketId] of Object.entries(room.seats)) {
    if (socketId && room.players[socketId]) {
      room.players[socketId].hand = hands[seat].sort();
    }
  }

  room.phase = 'playing';
  room.trick = {
    leadSeat: 'N',
    cards: { N: null, E: null, S: null, W: null },
    order: ['N', 'E', 'S', 'W'],
    currentIndex: 0
  };

  broadcastGameState(roomId);
}

function broadcastGameState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  for (const [socketId, player] of Object.entries(room.players)) {
    const stateForPlayer = {
      seats: room.seats,
      players: Object.fromEntries(
        Object.entries(room.players).map(([id, p]) => [id, { name: p.name, seat: p.seat }])
      ),
      phase: room.phase,
      trick: room.trick,
      yourSeat: player.seat,
      yourHand: player.hand
    };
    io.to(socketId).emit('game_state', stateForPlayer);
  }
}

app.get('/', (req, res) => {
  res.send('Bridge backend running');
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
