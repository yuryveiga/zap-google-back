require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = 3000;

// ─── CLIENTES WHATSAPP ─────────────────────────────────────
const clients = {};
const clientStates = {};

const ACCOUNTS = ['acc1', 'acc2'];

ACCOUNTS.forEach(id => {
  clientStates[id] = { status: 'starting', qr: null, ready: false };
});

// ─── CRM ───────────────────────────────────────────────────
const crmChats = {};

// ─── CRIA CLIENTE ──────────────────────────────────────────
function createClient(id) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox']
    }
  });

  client.on('qr', async (qr) => {
    const base64 = await qrcode.toDataURL(qr);
    clientStates[id] = { status: 'pending', qr: base64, ready: false };
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('ready', () => {
    clientStates[id] = { status: 'connected', qr: null, ready: true };
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  // 🔥 NOVA MENSAGEM (CRM)
  client.on('message', (msg) => {
    const chatId = `${id}:${msg.from}`;

    if (!crmChats[chatId]) {
      crmChats[chatId] = {
        id: chatId,
        accountId: id,
        name: msg.from,
        status: 'new',
        messages: []
      };
    }

    crmChats[chatId].messages.push({
      body: msg.body,
      fromMe: false,
      timestamp: msg.timestamp
    });

    io.emit('crm_update', crmChats[chatId]);
  });

  // 🔥 ENVIO DE MENSAGEM
  client.on('message_create', (msg) => {
    if (msg.fromMe) {
      const chatId = `${id}:${msg.to}`;
      if (!crmChats[chatId]) return;

      crmChats[chatId].messages.push({
        body: msg.body,
        fromMe: true,
        timestamp: msg.timestamp
      });

      io.emit('crm_update', crmChats[chatId]);
    }
  });

  return client;
}

// Inicializa
ACCOUNTS.forEach(id => {
  clients[id] = createClient(id);
  clients[id].initialize();
});

// ─── ROTAS ────────────────────────────────────────────────

app.get('/status', (req, res) => res.json(clientStates));

app.get('/crm', (req, res) => {
  res.json(Object.values(crmChats));
});

app.post('/crm/assign', (req, res) => {
  const { chatId } = req.body;

  if (crmChats[chatId]) {
    crmChats[chatId].status = 'assigned';
    io.emit('crm_update', crmChats[chatId]);
  }

  res.json({ ok: true });
});

app.post('/send', async (req, res) => {
  const { to, body } = req.body;
  const [accountId, chatId] = to.split(':');

  if (!clients[accountId]) return res.status(400).send();

  await clients[accountId].sendMessage(chatId, body);
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});