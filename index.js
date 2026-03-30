require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const ACCOUNTS = ['acc1', 'acc2'];

const clients = {};
const clientStates = {};

// ─── Criar cliente ─────────────────────────────────────
function createClient(id) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  clientStates[id] = {
    status: 'starting',
    qr: null,
    ready: false,
    name: id
  };

  client.on('qr', async (qr) => {
    const base64 = await qrcode.toDataURL(qr);
    clientStates[id].qr = base64;
    clientStates[id].status = 'pending';

    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('ready', () => {
    clientStates[id].status = 'connected';
    clientStates[id].ready = true;
    clientStates[id].qr = null;

    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('disconnected', () => {
    clientStates[id].status = 'disconnected';
    clientStates[id].ready = false;

    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  return client;
}

// ─── Inicializar clientes ──────────────────────────────
ACCOUNTS.forEach(id => {
  clients[id] = createClient(id);
});

// ─── ROTA INICIALIZAR (ESSENCIAL) ──────────────────────
app.post('/initialize/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (!clients[id]) {
      clients[id] = createClient(id);
    }

    await clients[id].initialize();

    res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── STATUS ────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json(clientStates);
});

// ─── RESET ─────────────────────────────────────────────
app.post('/reset/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (clients[id]) {
      await clients[id].destroy();
      clients[id] = createClient(id);
    }

    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SOCKET ────────────────────────────────────────────
io.on('connection', (socket) => {
  ACCOUNTS.forEach(id => {
    socket.emit('status_update', { accountId: id, ...clientStates[id] });
  });
});

// ─── START ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('Servidor rodando na porta ' + PORT);
});