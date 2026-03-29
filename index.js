require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// ─── Multi-Client Setup ───────────────────────────────────────────────────────

const ACCOUNTS = ['acc1', 'acc2'];
const clients = {};
const clientStates = {};

ACCOUNTS.forEach(id => {
  clientStates[id] = { status: 'starting', qr: null, ready: false };
});

<<<<<<< HEAD
ACCOUNTS.forEach(id => {
  clients[id] = createClient(id);
=======
ACCOUNTS.forEach((id, index) => {
  // Inicialização sequencial com delay de 5s para evitar conflito de puppeteer
  setTimeout(() => {
    console.log(`[${id}] Inicializando cliente...`);
    clients[id] = createClient(id);
  }, index * 5000);
>>>>>>> 50788916cc7d011a82c60dc939cafea067686f19
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
        '--disable-gpu'
      ],
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
    console.log(`[${id}] Cliente pronto e conectado`);
    clientStates[id].status = 'connected';
    clientStates[id].ready = true;
    clientStates[id].qr = null;
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('authenticated', () => {
    console.log(`[${id}] Autenticado com sucesso`);
<<<<<<< HEAD
    clientStates[id].status = 'authenticated';
    io.emit('status_update', { accountId: id, ...clientStates[id] });
=======
>>>>>>> 50788916cc7d011a82c60dc939cafea067686f19
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${id}] Falha na autenticação:`, msg);
    clientStates[id].status = 'disconnected';
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

<<<<<<< HEAD
  client.on('loading_screen', (percent, message) => {
    console.log(`[${id}] Carregando: ${percent}% - ${message}`);
    clientStates[id].status = 'loading';
    clientStates[id].loadingPercent = percent;
    io.emit('status_update', { accountId: id, ...clientStates[id] });
=======
  client.on('change_state', (state) => {
    console.log(`[${id}] Estado alterado para:`, state);
>>>>>>> 50788916cc7d011a82c60dc939cafea067686f19
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

<<<<<<< HEAD
=======
  client.initialize().catch(err => {
    console.error(`[${id}] Erro crítico na inicialização:`, err.message);
  });

>>>>>>> 50788916cc7d011a82c60dc939cafea067686f19
  return client;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseId(fullId) {
    const parts = fullId.split(':');
    if (parts.length < 2) return { accountId: ACCOUNTS[0], chatId: fullId };
    return { accountId: parts[0], chatId: parts.slice(1).join(':') };
}

async function withTimeout(fn, ms = 10000) {
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
  console.log('Cliente conectado via socket');
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

app.post('/initialize/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const client = clients[accountId];
  if (!client) return res.status(404).json({ error: 'Conta nao encontrada' });
  
  // Se ja estiver conectando ou conectado, ignora
  if (clientStates[accountId].status === 'pending' || clientStates[accountId].ready || clientStates[accountId].status === 'initializing') {
    return res.json({ status: clientStates[accountId].status });
  }
  
  console.log(`[${accountId}] Inicializacao manual iniciada`);
  clientStates[accountId].status = 'initializing';
  io.emit('status_update', { accountId, ...clientStates[accountId] });
  
  client.initialize().catch(err => {
    console.error(`[${accountId}] Erro na inicializacao:`, err.message);
    clientStates[accountId].status = 'disconnected';
    io.emit('status_update', { accountId, ...clientStates[accountId] });
  });
  
  res.json({ ok: true });
});

// Lista todos os chats (Unificado)
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
      } catch (e) {
        console.error(`Erro ao carregar chats de ${id}:`, e.message);
      }
    }

    // Ordena por timestamp da última mensagem
    allResults.sort((a, b) => {
      const tA = a.lastMessage?.timestamp || 0;
      const tB = b.lastMessage?.timestamp || 0;
      return tB - tA;
    });

    res.json(allResults);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mensagens de um chat
app.get('/messages/:fullId', async (req, res) => {
  try {
    const { accountId, chatId } = parseId(req.params.fullId);
    if (!clientStates[accountId].ready) return res.status(503).json({ error: 'Conta offline' });

    const limit = parseInt(req.query.limit) || 50;
    const chat = await withRetry(() => clients[accountId].getChatById(chatId));
    const msgs = await withRetry(() => chat.fetchMessages({ limit }));

    try { await chat.sendSeen(); } catch (_) { }

    const result = msgs.map(m => ({
      id: m.id._serialized,
      body: m.body || (m.hasMedia ? 'Midia' : ''),
      fromMe: m.fromMe,
      timestamp: m.timestamp,
      type: m.type,
      hasMedia: m.hasMedia,
      ack: m.ack,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enviar mensagem
app.post('/send', async (req, res) => {
  try {
    const { to, body } = req.body;
    const { accountId, chatId } = parseId(to);
    if (!clientStates[accountId].ready) return res.status(503).json({ error: 'Conta offline' });

    const msg = await clients[accountId].sendMessage(chatId, body);
    res.json({ ok: true, id: msg.id._serialized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Avatar de um contato
app.get('/avatar/:fullId', async (req, res) => {
  try {
    const { accountId, chatId } = parseId(req.params.fullId);
    if (!clientStates[accountId].ready) return res.json({ url: null });
    const url = await clients[accountId].getProfilePicUrl(chatId).catch(() => null);
    res.json({ url: url || null });
  } catch (err) {
    res.json({ url: null });
  }
});

// Info de contato
app.get('/contact/:fullId', async (req, res) => {
  try {
    const { accountId, chatId } = parseId(req.params.fullId);
    if (!clientStates[accountId].ready) return res.status(503).json({ error: 'Offline' });
    
    const contact = await clients[accountId].getContactById(chatId).catch(() => null);
    
    if (!contact) {
      const number = chatId.split('@')[0];
      return res.json({ id: req.params.fullId, name: number, number });
    }

    res.json({
      id: `${accountId}:${contact.id._serialized}`,
      name: contact.name || contact.pushname || contact.id.user,
      pushname: contact.pushname || '',
      number: contact.id.user,
      isMe: contact.isMe || false,
      about: await contact.getAbout().catch(() => null),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar contato' });
  }
});

server.listen(PORT, () => {
  console.log('Servidor unificado rodando na porta ' + PORT);
});