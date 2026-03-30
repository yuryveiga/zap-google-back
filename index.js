require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs-extra');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const ACCOUNTS = ['acc1', 'acc2'];
const clients = {};
const states = {};

// ─── CREATE CLIENT ─────────────────────────
function createClient(id) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  states[id] = {
    status: 'starting',
    qr: null,
    ready: false,
    name: id
  };

  client.on('qr', async qr => {
    states[id].qr = await qrcode.toDataURL(qr);
    states[id].status = 'pending';
    io.emit('status_update', { accountId: id, ...states[id] });
  });

  client.on('ready', () => {
    states[id].status = 'connected';
    states[id].ready = true;
    states[id].qr = null;
    io.emit('status_update', { accountId: id, ...states[id] });
  });

  client.on('authenticated', () => {
    states[id].status = 'authenticated';
    io.emit('status_update', { accountId: id, ...states[id] });
  });

  client.on('disconnected', () => {
    states[id].status = 'disconnected';
    states[id].ready = false;
    io.emit('status_update', { accountId: id, ...states[id] });
  });

  client.on('message', msg => {
    io.emit('new_message', {
      accountId: id,
      chatId: msg.from,
      body: msg.body || 'Midia',
      fromMe: false,
      timestamp: msg.timestamp
    });
  });

  client.on('message_create', msg => {
    if (msg.fromMe) {
      io.emit('new_message', {
        accountId: id,
        chatId: msg.to,
        body: msg.body || '',
        fromMe: true,
        timestamp: msg.timestamp
      });
    }
  });

  return client;
}

// init base
ACCOUNTS.forEach(id => {
  clients[id] = createClient(id);
});

// ─── INITIALIZE ─────────────────────────
app.post('/initialize/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await clients[id].initialize();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── STATUS ─────────────────────────
app.get('/status', (req, res) => res.json(states));

// ─── RESET ─────────────────────────
app.post('/reset/:id', async (req, res) => {
  const { id } = req.params;

  if (clients[id]) {
    await clients[id].destroy();
  }

  const sessionPath = path.join('.wwebjs_auth', `session-${id}`);
  if (await fs.pathExists(sessionPath)) {
    await fs.remove(sessionPath);
  }

  clients[id] = createClient(id);

  res.json({ ok: true });
});

// ─── CHATS ─────────────────────────
app.get('/chats', async (req, res) => {
  let result = [];

  for (const id of ACCOUNTS) {
    if (!states[id].ready) continue;

    const chats = await clients[id].getChats();

    result.push(...chats.map(c => ({
      id: `${id}:${c.id._serialized}`,
      name: c.name || c.id.user,
      accountId: id,
      lastMessage: c.lastMessage ? {
        body: c.lastMessage.body || 'Midia',
        timestamp: c.lastMessage.timestamp,
        fromMe: c.lastMessage.fromMe
      } : null,
      unreadCount: c.unreadCount || 0
    })));
  }

  result.sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));

  res.json(result);
});

// ─── MESSAGES ─────────────────────────
app.get('/messages/:fullId', async (req, res) => {
  const [accountId, ...rest] = req.params.fullId.split(':');
  const chatId = rest.join(':');

  const chat = await clients[accountId].getChatById(chatId);
  const msgs = await chat.fetchMessages({ limit: 50 });

  res.json(msgs.map(m => ({
    body: m.body || 'Midia',
    fromMe: m.fromMe,
    timestamp: m.timestamp,
    ack: m.ack
  })));
});

// ─── SEND ─────────────────────────
app.post('/send', async (req, res) => {
  const { to, body } = req.body;
  const [accountId, ...rest] = to.split(':');
  const chatId = rest.join(':');

  await clients[accountId].sendMessage(chatId, body);

  res.json({ ok: true });
});

// ─── CONTACT ─────────────────────────
app.get('/contact/:fullId', async (req, res) => {
  const [accountId, ...rest] = req.params.fullId.split(':');
  const chatId = rest.join(':');

  const contact = await clients[accountId].getContactById(chatId);

  res.json({
    name: contact.name || contact.pushname || contact.id.user,
    number: contact.id.user
  });
});

// ─── SOCKET ─────────────────────────
io.on('connection', socket => {
  ACCOUNTS.forEach(id => {
    socket.emit('status_update', { accountId: id, ...states[id] });
  });
});

server.listen(PORT, () => console.log('Rodando na porta ' + PORT));