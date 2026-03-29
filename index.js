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
const io = new Server(server, {
  cors: { origin: "*" }
});
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});
app.use(express.static(path.join(process.cwd(), 'public')));

// ─── Multi-Client Setup ───────────────────────────────────────────────────────

const ACCOUNTS = ['acc1', 'acc2'];
const clients = {};
const clientStates = {};

ACCOUNTS.forEach(id => {
  clientStates[id] = { status: 'starting', qr: null, ready: false, loadingPercent: 0 };
});

ACCOUNTS.forEach(id => {
  clients[id] = createClient(id);
});

function createClient(id) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ],
      executablePath: process.env.CHROME_PATH || undefined
    }
  });

  client.on('qr', async (qr) => {
    console.log(`[${id}] QR Code recebido`);
    const base64 = await qrcode.toDataURL(qr);
    clientStates[id].qr = base64;
    clientStates[id].status = 'pending';
    clientStates[id].ready = false;
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('ready', () => {
    console.log(`[${id}] Cliente conectado`);
    clientStates[id].status = 'connected';
    clientStates[id].ready = true;
    clientStates[id].qr = null;
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('authenticated', () => {
    console.log(`[${id}] Autenticado`);
    clientStates[id].status = 'authenticated';
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${id}] Falha na autenticação:`, msg);
    clientStates[id].status = 'disconnected';
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`[${id}] Carregando: ${percent}% - ${message}`);
    clientStates[id].status = 'loading';
    clientStates[id].loadingPercent = percent;
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('disconnected', (reason) => {
    console.log(`[${id}] Desconectado:`, reason);
    clientStates[id].status = 'disconnected';
    clientStates[id].ready = false;
    clientStates[id].qr = null;
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('message', (msg) => {
    io.emit('new_message', {
      accountId: id,
      id: msg.id._serialized,
      chatId: msg.from,
      body: msg.body || (msg.hasMedia ? 'Midia' : ''),
      fromMe: false,
      timestamp: msg.timestamp,
      type: msg.type,
      hasMedia: msg.hasMedia,
    });
  });

  client.on('message_create', (msg) => {
    if (msg.fromMe) {
      io.emit('new_message', {
        accountId: id,
        id: msg.id._serialized,
        chatId: msg.to,
        body: msg.body || '',
        fromMe: true,
        timestamp: msg.timestamp,
        type: msg.type,
      });
    }
  });

  return client;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseId(fullId) {
    const parts = fullId.split(':');
    if (parts.length < 2) return { accountId: ACCOUNTS[0], chatId: fullId };
    return { accountId: parts[0], chatId: parts.slice(1).join(':') };
}

async function withTimeout(fn, ms = 15000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout apos ' + ms + 'ms')), ms)
    )
  ]);
}

async function withRetry(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await withTimeout(fn);
    } catch (err) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
      else throw err;
    }
  }
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('[Socket] Cliente conectado');
  ACCOUNTS.forEach(id => {
    socket.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  socket.on('send_message', async ({ fullId, body }) => {
    try {
      const { accountId, chatId } = parseId(fullId);
      const client = clients[accountId];
      if (client && clientStates[accountId].ready) {
        await client.sendMessage(chatId, body);
      }
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });
});

// ─── Rotas REST ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.get('/status', (req, res) => {
  res.json(clientStates);
});

app.get('/get-qr', (req, res) => {
  let html = `<html><body style="background:#111b21; color:white; font-family:sans-serif; display:flex; gap:20px; text-align:center; padding:40px">`;
  ACCOUNTS.forEach(id => {
    const s = clientStates[id];
    html += `<div style="background:#202c33; padding:20px; border-radius:12px; min-width:250px"><h3>${id}</h3><p>Status: <b>${s.status}</b></p>${s.qr ? `<img src="${s.qr}" style="background:white; padding:10px; border-radius:8px"/>` : '<p>Sem QR pendente</p>'}</div>`;
  });
  html += `</body></html>`;
  res.send(html);
});

app.post('/initialize/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const client = clients[accountId];
  if (!client) return res.status(404).json({ error: 'Conta nao encontrada' });
  
  const s = clientStates[accountId];
  if (s.status === 'pending' || s.ready || s.status === 'initializing' || s.status === 'loading') {
    return res.json({ status: s.status });
  }
  
  console.log(`[${accountId}] Inicializacao iniciada`);
  clientStates[accountId].status = 'initializing';
  io.emit('status_update', { accountId, ...clientStates[accountId] });
  
  client.initialize().catch(err => {
    console.error(`[${accountId}] Erro:`, err.message);
    clientStates[accountId].status = 'disconnected';
    io.emit('status_update', { accountId, ...clientStates[accountId] });
  });
  
  res.json({ ok: true });
});

app.post('/reset/:accountId', async (req, res) => {
  const { accountId } = req.params;
  console.log(`[${accountId}] Reset de sessao solicitado`);
  
  try {
    // 1. Tenta fechar o cliente se existir
    if (clients[accountId]) {
        try { await clients[accountId].destroy(); } catch (_) {}
    }

    // 2. Apaga pastas de sessao
    const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `session-${accountId}`);
    if (await fs.pathExists(sessionPath)) {
        await fs.remove(sessionPath);
        console.log(`[${accountId}] Pasta de sessao removida`);
    }

    // 3. Reinicia o objeto do cliente
    clientStates[accountId] = { status: 'starting', qr: null, ready: false, loadingPercent: 0 };
    clients[accountId] = createClient(accountId);
    
    io.emit('status_update', { accountId, ...clientStates[accountId] });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${accountId}] Erro no reset:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/chats', async (req, res) => {
  try {
    const allResults = [];
    for (const id of ACCOUNTS) {
      if (!clientStates[id].ready) continue;
      try {
        const chats = await withRetry(() => clients[id].getChats());
        const mapped = chats.slice(0, 40).map(c => {
          let name = c.name;
          if (!name && c.id && c.id.user) name = c.id.user;
          return {
            id: `${id}:${c.id._serialized}`,
            name: name || '',
            isGroup: c.isGroup || false,
            lastMessage: c.lastMessage ? {
              body: c.lastMessage.body || (c.lastMessage.hasMedia ? 'Midia' : ''),
              timestamp: c.lastMessage.timestamp || null,
              fromMe: c.lastMessage.fromMe || false,
            } : null,
            unreadCount: c.unreadCount || 0,
            accountId: id,
          };
        });
        allResults.push(...mapped);
      } catch (e) { console.error(`Erro em /chats (${id}):`, e.message); }
    }
    allResults.sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
    res.json(allResults);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/messages/:fullId', async (req, res) => {
  try {
    const { accountId, chatId } = parseId(req.params.fullId);
    if (!clientStates[accountId].ready) return res.status(503).json({ error: 'Offline' });
    const limit = parseInt(req.query.limit) || 50;
    const chat = await withRetry(() => clients[accountId].getChatById(chatId));
    const msgs = await withRetry(() => chat.fetchMessages({ limit }));
    try { await chat.sendSeen(); } catch (_) { }
    res.json(msgs.map(m => ({
      id: m.id._serialized,
      body: m.body || (m.hasMedia ? 'Midia' : ''),
      fromMe: m.fromMe,
      timestamp: m.timestamp,
      type: m.type,
      hasMedia: m.hasMedia,
      ack: m.ack,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/send', async (req, res) => {
  try {
    const { to, body } = req.body;
    const { accountId, chatId } = parseId(to);
    if (!clientStates[accountId].ready) return res.status(503).json({ error: 'Offline' });
    const msg = await clients[accountId].sendMessage(chatId, body);
    res.json({ ok: true, id: msg.id._serialized });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/avatar/:fullId', async (req, res) => {
  try {
    const { accountId, chatId } = parseId(req.params.fullId);
    if (!clientStates[accountId].ready) return res.json({ url: null });
    const url = await clients[accountId].getProfilePicUrl(chatId).catch(() => null);
    res.json({ url: url || null });
  } catch (err) { res.json({ url: null }); }
});

app.get('/contact/:fullId', async (req, res) => {
  try {
    const { accountId, chatId } = parseId(req.params.fullId);
    if (!clientStates[accountId].ready) return res.status(503).json({ error: 'Offline' });
    const contact = await clients[accountId].getContactById(chatId).catch(() => null);
    if (!contact) return res.json({ id: req.params.fullId, name: chatId.split('@')[0] });
    res.json({
      id: `${accountId}:${contact.id._serialized}`,
      name: contact.name || contact.pushname || contact.id.user,
      pushname: contact.pushname || '',
      number: contact.id.user,
      isMe: contact.isMe || false,
      about: await contact.getAbout().catch(() => null),
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar contato' }); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
});