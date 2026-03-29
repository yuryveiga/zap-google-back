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

let qrCodeBase64 = null;
let status = 'starting';
let clientReady = false;

const client = new Client({
  authStrategy: new LocalAuth(),
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

// ─── Helper: retry com delay ──────────────────────────────────────────────────

// Substitua a função withRetry por essa versão com timeout:
async function withTimeout(fn, ms = 10000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout após ${ms}ms`)), ms))
  ]);
}

async function withRetry(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await withTimeout(fn);
    } catch (err) {
      console.error(`Tentativa ${i + 1}/${retries} falhou: ${err.message}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
      else throw err;
    }
  }
}

// ─── Helper: aguarda cliente estar pronto ─────────────────────────────────────

async function waitReady(timeoutMs = 15000) {
  if (clientReady) return;
  const start = Date.now();
  while (!clientReady) {
    if (Date.now() - start > timeoutMs) throw new Error('Timeout aguardando cliente WhatsApp');
    await new Promise(r => setTimeout(r, 500));
  }
}

// ─── Eventos WhatsApp ─────────────────────────────────────────────────────────

client.on('qr', async (qr) => {
  console.log('QR gerado');
  qrCodeBase64 = await qrcode.toDataURL(qr);
  status = 'pending';
  clientReady = false;
  io.emit('status', { status, qr: qrCodeBase64 });
});

client.on('ready', () => {
  console.log('WhatsApp conectado');
  status = 'connected';
  clientReady = true;
  qrCodeBase64 = null;
  io.emit('status', { status });
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp desconectado:', reason);
  status = 'disconnected';
  clientReady = false;
  io.emit('status', { status });
});

client.on('auth_failure', (msg) => {
  console.error('Auth failure:', msg);
  status = 'disconnected';
  clientReady = false;
  io.emit('status', { status });
});

client.on('loading_screen', (percent, message) => {
  console.log(`Carregando: ${percent}% - ${message}`);
});

client.on('message', (msg) => {
  io.emit('new_message', {
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
      id: msg.id._serialized,
      chatId: msg.to,
      body: msg.body || '',
      fromMe: true,
      timestamp: msg.timestamp,
      type: msg.type,
    });
  }
});

client.initialize().catch(err => {
  console.error('Erro ao inicializar:', err.message);
  console.error(err.stack);
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Cliente conectado via socket');
  socket.emit('status', { status, qr: qrCodeBase64 });

  socket.on('send_message', async ({ to, body }) => {
    try {
      await client.sendMessage(to, body);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });
});

// ─── Rotas REST ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.get('/get-qr', (req, res) => {
  res.json({ status, qr: qrCodeBase64 });
});

// Lista todos os chats
app.get('/chats', async (req, res) => {
  try {
    if (status !== 'connected') {
      return res.status(503).json({ error: 'WhatsApp nao conectado', status });
    }

    await waitReady();

    const chats = await withRetry(() => client.getChats());

    const result = chats.slice(0, 50).map(c => {
      try {
        return {
          id: c.id._serialized,
          name: c.name || c.id.user || '',
          isGroup: c.isGroup || false,
          lastMessage: c.lastMessage ? {
            body: c.lastMessage.body || (c.lastMessage.hasMedia ? 'Midia' : ''),
            timestamp: c.lastMessage.timestamp || null,
            fromMe: c.lastMessage.fromMe || false,
          } : null,
          unreadCount: c.unreadCount || 0,
        };
      } catch (e) {
        console.error('Erro ao mapear chat:', e.message);
        return null;
      }
    }).filter(Boolean);

    console.log('/chats retornou ' + result.length + ' conversas');
    res.json(result);
  } catch (err) {
    console.error('Erro em /chats:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Mensagens de um chat
app.get('/messages/:chatId', async (req, res) => {
  try {
    if (status !== 'connected') {
      return res.status(503).json({ error: 'WhatsApp nao conectado' });
    }

    await waitReady();

    const limit = parseInt(req.query.limit) || 50;
    const chat = await withRetry(() => client.getChatById(req.params.chatId));
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
    console.error('Erro em /messages:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Enviar mensagem
app.post('/send', async (req, res) => {
  try {
    if (status !== 'connected') {
      return res.status(503).json({ error: 'WhatsApp nao conectado' });
    }
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Campos to e body obrigatorios' });
    const msg = await client.sendMessage(to, body);
    res.json({ ok: true, id: msg.id._serialized });
  } catch (err) {
    console.error('Erro em /send:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Avatar de um contato
app.get('/avatar/:contactId', async (req, res) => {
  try {
    if (status !== 'connected') return res.json({ url: null });
    const url = await client.getProfilePicUrl(req.params.contactId).catch(() => null);
    res.json({ url: url || null });
  } catch (err) {
    res.json({ url: null });
  }
});

// Info de contato
app.get('/contact/:contactId', async (req, res) => {
  try {
    if (status !== 'connected') return res.status(503).json({ error: 'Nao conectado' });
    const contact = await client.getContactById(req.params.contactId);
    res.json({
      id: contact.id._serialized,
      name: contact.name || contact.pushname || contact.id.user,
      pushname: contact.pushname,
      number: contact.id.user,
      isMe: contact.isMe,
    });
  } catch (err) {
    console.error('Erro em /contact:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('Servidor rodando na porta ' + PORT);
});