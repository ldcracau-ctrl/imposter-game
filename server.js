import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ─── Word list ────────────────────────────────────────────────────────────────
const WORDS = [
  // Animals
  'Elephant', 'Penguin', 'Crocodile', 'Flamingo', 'Cheetah', 'Gorilla', 'Octopus', 'Dolphin',
  'Vulture', 'Chameleon', 'Platypus', 'Wolverine', 'Manta Ray', 'Snow Leopard', 'Axolotl',
  // Food
  'Pizza', 'Sushi', 'Taco', 'Croissant', 'Dumplings', 'Burrito', 'Lasagna', 'Ramen',
  'Pretzel', 'Gyoza', 'Falafel', 'Tiramisu', 'Baklava', 'Churro', 'Pavlova',
  // Places
  'Airport', 'Casino', 'Hospital', 'Library', 'Museum', 'Stadium', 'Submarine', 'Volcano',
  'Lighthouse', 'Observatory', 'Monastery', 'Amusement Park', 'Prison', 'Ski Resort', 'Cruise Ship',
  // Objects
  'Telescope', 'Compass', 'Typewriter', 'Accordion', 'Periscope', 'Metronome', 'Sundial',
  'Microscope', 'Boomerang', 'Sextant', 'Didgeridoo', 'Kaleidoscope', 'Abacus', 'Zeppelin',
  // Sports & Activities
  'Archery', 'Fencing', 'Polo', 'Curling', 'Bobsled', 'Parkour', 'Kayaking', 'Skydiving',
  'Bouldering', 'Jousting', 'Wakeboarding', 'Falconry', 'Sumo Wrestling', 'Ice Skating',
  // Nature
  'Avalanche', 'Geyser', 'Quicksand', 'Tornado', 'Glacier', 'Coral Reef', 'Bioluminescence',
  'Eclipse', 'Tidal Wave', 'Sinkholes', 'Aurora', 'Monsoon', 'Desert Mirage',
];

// ─── Utility ──────────────────────────────────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return 'localhost';
}

function randomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(room, data) {
  room.players.forEach(p => send(p.ws, data));
}

// ─── Game state ───────────────────────────────────────────────────────────────
const rooms = {}; // code → room

// ─── HTTP server ──────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const localIP = getLocalIP();

wss.on('connection', (ws) => {
  ws._id = randomId();
  ws._roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload = {} } = msg;

    switch (type) {
      case 'CREATE_ROOM': {
        const name = String(payload.name || 'Host').slice(0, 20);
        let code;
        do { code = randomCode(); } while (rooms[code]);

        rooms[code] = {
          hostId: ws._id,
          players: [{ id: ws._id, name, ws, role: null }],
          imposterCount: 1,
          gameActive: false,
          word: null,
        };
        ws._roomCode = code;

        send(ws, {
          type: 'ROOM_CREATED',
          payload: {
            code,
            playerId: ws._id,
            hostUrl: `http://${localIP}:${PORT}`,
          },
        });
        break;
      }

      case 'JOIN_ROOM': {
        const code = String(payload.code || '').toUpperCase().trim();
        const name = String(payload.name || 'Player').slice(0, 20);
        const room = rooms[code];

        if (!room) {
          send(ws, { type: 'ERROR', payload: { message: 'Room not found. Check the code and try again.' } });
          return;
        }
        if (room.gameActive) {
          send(ws, { type: 'ERROR', payload: { message: 'Game already in progress.' } });
          return;
        }
        if (room.players.length >= 16) {
          send(ws, { type: 'ERROR', payload: { message: 'Room is full (max 16 players).' } });
          return;
        }
        // Prevent duplicate names
        const safeName = room.players.some(p => p.name === name)
          ? name + Math.floor(Math.random() * 99)
          : name;

        room.players.push({ id: ws._id, name: safeName, ws, role: null });
        ws._roomCode = code;

        send(ws, {
          type: 'JOINED',
          payload: { playerId: ws._id, name: safeName, code, isHost: false },
        });

        broadcastPlayerList(room);
        break;
      }

      case 'SET_IMPOSTER_COUNT': {
        const room = getRoomForWs(ws);
        if (!room || room.hostId !== ws._id) return;
        const count = Math.max(1, Math.min(3, parseInt(payload.count) || 1));
        room.imposterCount = count;
        broadcast(room, { type: 'IMPOSTER_COUNT', payload: { count } });
        break;
      }

      case 'START_GAME': {
        const room = getRoomForWs(ws);
        if (!room || room.hostId !== ws._id) return;
        if (room.players.length < 2) {
          send(ws, { type: 'ERROR', payload: { message: 'Need at least 2 players to start.' } });
          return;
        }

        const word = WORDS[Math.floor(Math.random() * WORDS.length)];
        room.word = word;
        room.gameActive = true;

        // Shuffle and pick imposters
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);
        const imposterIds = new Set(shuffled.slice(0, room.imposterCount).map(p => p.id));

        room.players.forEach(player => {
          const isImposter = imposterIds.has(player.id);
          player.role = isImposter ? 'IMPOSTER' : 'GOOD LITTLE BOY';
          send(player.ws, {
            type: 'GAME_STARTED',
            payload: {
              role: player.role,
              word: isImposter ? null : word,
              imposterCount: room.imposterCount,
              playerCount: room.players.length,
              isHost: player.id === room.hostId,
            },
          });
        });

        broadcastPlayerList(room);
        break;
      }

      case 'END_ROUND': {
        // Host ends round — reveal all roles, stay on round-over screen
        const room = getRoomForWs(ws);
        if (!room || room.hostId !== ws._id) return;
        const revealedRoles = room.players.map(p => ({ id: p.id, name: p.name, role: p.role, isHost: p.id === room.hostId }));
        broadcast(room, { type: 'ROLES_REVEALED', payload: { players: revealedRoles, word: room.word } });
        room.gameActive = false;
        room.word = null;
        room.players.forEach(p => { p.role = null; });
        break;
      }

      case 'END_GAME': {
        // Host returns everyone to lobby from round-over screen
        const room = getRoomForWs(ws);
        if (!room || room.hostId !== ws._id) return;
        broadcast(room, { type: 'GAME_ENDED', payload: {} });
        broadcastPlayerList(room);
        break;
      }

      case 'REVEAL_WORD': {
        // Host reveals the secret word to all players (after voting)
        const room = getRoomForWs(ws);
        if (!room || room.hostId !== ws._id || !room.word) return;
        broadcast(room, { type: 'WORD_REVEALED', payload: { word: room.word } });
        break;
      }
    }
  });

  ws.on('close', () => {
    const code = ws._roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (ws._id === room.hostId) {
      // Host disconnected — notify and destroy room
      broadcast(room, { type: 'HOST_LEFT', payload: {} });
      delete rooms[code];
    } else {
      room.players = room.players.filter(p => p.id !== ws._id);
      broadcastPlayerList(room);
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getRoomForWs(ws) {
  const code = ws._roomCode;
  return code ? rooms[code] : null;
}

function broadcastPlayerList(room) {
  const list = room.players.map(p => ({
    id: p.id,
    name: p.name,
    isHost: p.id === room.hostId,
    role: null, // Never reveal roles in player list — only shown on individual reveal screen
  }));
  broadcast(room, { type: 'PLAYER_LIST', payload: { players: list } });
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║         IMPOSTER — Game Server           ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Local:    http://localhost:${PORT}         ║`);
  console.log(`║  Network:  http://${localIP}:${PORT}`.padEnd(44) + `║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
