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

// ─── Eventos WhatsApp ────────────────────────────────────────────────────────

client.on('qr', async (qr) => {
  console.log('QR gerado');
  qrCodeBase64 = await qrcode.toDataURL(qr);
  status = 'pending';
  io.emit('status', { status, qr: qrCodeBase64 });
});

client.on('ready', () => {
  console.log('WhatsApp conectado');
  status = 'connected';
  qrCodeBase64 = null;
  io.emit('status', { status });
});

client.on('disconnected', () => {
  console.log('WhatsApp desconectado');
  status = 'disconnected';
  io.emit('status', { status });
});

client.on('message', async (msg) => {
  // Ignora mensagens de grupos por padrão (remova o if para incluir grupos)
  const payload = {
    id: msg.id._serialized,
    chatId: msg.from,
    body: msg.body,
    fromMe: false,
    timestamp: msg.timestamp,
    type: msg.type,
    hasMedia: msg.hasMedia,
  };
  io.emit('new_message', payload);
});

client.on('message_create', async (msg) => {
  if (msg.fromMe) {
    io.emit('new_message', {
      id: msg.id._serialized,
      chatId: msg.to,
      body: msg.body,
      fromMe: true,
      timestamp: msg.timestamp,
      type: msg.type,
    });
  }
});

client.on('auth_failure', (msg) => {
  console.error('❌ Auth failure:', msg);
  status = 'disconnected';
  io.emit('status', { status });
});

client.on('loading_screen', (percent, message) => {
  console.log(`⏳ Carregando WhatsApp: ${percent}% - ${message}`);
});

client.initialize().catch(err => {
  console.error('❌ Erro ao inicializar cliente:', err.message);
  console.error(err.stack);
});

// ─── Socket.io ───────────────────────────────────────────────────────────────

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

// ─── Rotas REST ──────────────────────────────────────────────────────────────

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
      return res.status(503).json({ error: 'WhatsApp não conectado' });
    }
    const chats = await client.getChats();
    const result = chats.slice(0, 50).map(c => ({
      id: c.id._serialized,
      name: c.name || c.id.user,
      isGroup: c.isGroup,
      lastMessage: c.lastMessage
        ? {
          body: c.lastMessage.body || (c.lastMessage.hasMedia ? '📎 Mídia' : ''),
          timestamp: c.lastMessage.timestamp,
          fromMe: c.lastMessage.fromMe,
        }
        : null,
      unreadCount: c.unreadCount,
    }));
    res.json(result);
  } catch (err) {
    console.error('❌ Erro em /chats:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Mensagens de um chat
app.get('/messages/:chatId', async (req, res) => {
  try {
    if (status !== 'connected') {
      return res.status(503).json({ error: 'WhatsApp não conectado' });
    }
    const limit = parseInt(req.query.limit) || 50;
    const chat = await client.getChatById(req.params.chatId);
    const msgs = await chat.fetchMessages({ limit });
    await chat.sendSeen();

    const result = msgs.map(m => ({
      id: m.id._serialized,
      body: m.body || (m.hasMedia ? '📎 Mídia' : ''),
      fromMe: m.fromMe,
      timestamp: m.timestamp,
      type: m.type,
      hasMedia: m.hasMedia,
      ack: m.ack, // 0=pendente 1=enviado 2=entregue 3=lido
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enviar mensagem
app.post('/send', async (req, res) => {
  try {
    if (status !== 'connected') {
      return res.status(503).json({ error: 'WhatsApp não conectado' });
    }
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Campos to e body obrigatórios' });
    const msg = await client.sendMessage(to, body);
    res.json({ ok: true, id: msg.id._serialized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Avatar de um contato (base64)
app.get('/avatar/:contactId', async (req, res) => {
  try {
    if (status !== 'connected') return res.status(503).json({ error: 'Não conectado' });
    const url = await client.getProfilePicUrl(req.params.contactId).catch(() => null);
    res.json({ url: url || null });
  } catch (err) {
    res.json({ url: null });
  }
});

// Info de contato
app.get('/contact/:contactId', async (req, res) => {
  try {
    if (status !== 'connected') return res.status(503).json({ error: 'Não conectado' });
    const contact = await client.getContactById(req.params.contactId);
    res.json({
      id: contact.id._serialized,
      name: contact.name || contact.pushname || contact.id.user,
      pushname: contact.pushname,
      number: contact.id.user,
      isMe: contact.isMe,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
