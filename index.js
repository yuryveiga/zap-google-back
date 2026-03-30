require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = 3000;

// ─── USUÁRIOS (SIMPLES) ─────────────────────────────
const users = [
  { id: 1, username: 'admin', password: '123', name: 'Administrador' },
  { id: 2, username: 'user1', password: '123', name: 'Atendente 1' }
];

const sessions = {};

// ─── AUTH MIDDLEWARE ───────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization;
  const user = sessions[token];
  if (!user) return res.status(401).json({ error: 'Não autorizado' });
  req.user = user;
  next();
}

// ─── WHATSAPP ──────────────────────────────────────
const clients = {};
const clientStates = {};
const ACCOUNTS = ['acc1'];

ACCOUNTS.forEach(id => {
  clientStates[id] = { status: 'starting', qr: null, ready: false };
});

// ─── CRM ───────────────────────────────────────────
const crmChats = {};

// ─── CLIENT ────────────────────────────────────────
function createClient(id) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: { headless: true, args: ['--no-sandbox'] }
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

  client.on('message', (msg) => {
    const chatId = `${id}:${msg.from}`;

    if (!crmChats[chatId]) {
      crmChats[chatId] = {
        id: chatId,
        name: msg.from,
        status: 'new',
        assignedTo: null,
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

ACCOUNTS.forEach(id => {
  clients[id] = createClient(id);
  clients[id].initialize();
});

// ─── ROTAS ─────────────────────────────────────────

// LOGIN
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Login inválido' });

  const token = crypto.randomBytes(16).toString('hex');
  sessions[token] = user;

  res.json({ token, user });
});

// CRM
app.get('/crm', auth, (req, res) => {
  res.json(Object.values(crmChats));
});

// ASSUMIR CHAT
app.post('/crm/assign', auth, (req, res) => {
  const { chatId } = req.body;

  if (crmChats[chatId]) {
    crmChats[chatId].status = 'assigned';
    crmChats[chatId].assignedTo = req.user.name;

    io.emit('crm_update', crmChats[chatId]);
  }

  res.json({ ok: true });
});

// ENVIAR
app.post('/send', auth, async (req, res) => {
  const { to, body } = req.body;
  const [accountId, chatId] = to.split(':');

  const chat = crmChats[to];
  if (!chat) return res.status(404).send();

  if (chat.assignedTo !== req.user.name) {
    return res.status(403).json({ error: 'Você não é o responsável' });
  }

  await clients[accountId].sendMessage(chatId, body);

  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});