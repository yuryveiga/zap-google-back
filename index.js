require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs-extra');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zap-google-secret-key-2024';

const users = [];
bcrypt.hash('1234', 10).then(hash => users.push({ username: 'yury', password: hash }));

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// Captura logs em memória para debug remoto
const serverLogs = [];
const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log = (...a) => { serverLogs.push({ t: new Date().toISOString(), level: 'info', msg: a.join(' ') }); if (serverLogs.length > 200) serverLogs.shift(); _log(...a); };
console.error = (...a) => { serverLogs.push({ t: new Date().toISOString(), level: 'error', msg: a.join(' ') }); if (serverLogs.length > 200) serverLogs.shift(); _err(...a); };

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});
app.use(express.static(path.join(process.cwd(), 'public')));

// ─── Multi-Client Setup ───────────────────────────────────────────────────────

// Inicia vazio para obrigar os 2 slots vazios na interface
const SESSIONS_FILE = path.join(process.cwd(), 'sessions.json');
let ACCOUNTS = [];
let accountNames = {};

if (fs.existsSync(SESSIONS_FILE)) {
  try {
    const data = fs.readJsonSync(SESSIONS_FILE);
    ACCOUNTS = data.accounts || [];
    accountNames = data.names || {};
  } catch (e) { console.error('Erro ao carregar sessões:', e.message); }
}

function saveSessions() {
  try {
    fs.writeJsonSync(SESSIONS_FILE, { accounts: ACCOUNTS, names: accountNames });
  } catch (e) { console.error('Erro ao salvar sessões:', e.message); }
}

const clients = {};
const clientStates = {};

ACCOUNTS.forEach(id => {
  clientStates[id] = { status: 'starting', qr: null, ready: false, loadingPercent: 0, name: accountNames[id] || id, reason: null };
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
      ]
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
    clientStates[id].reason = null;
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
    clientStates[id].reason = msg;
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
    clientStates[id].reason = reason;
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

// Inicializa clientes existentes
ACCOUNTS.forEach(id => {
  clients[id] = createClient(id);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseId(fullId) {
  const parts = fullId.split(':');
  if (parts.length < 2) return { accountId: ACCOUNTS[0] || '', chatId: fullId };
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
      if (client && clientStates[accountId]?.ready) {
        await client.sendMessage(chatId, body);
      }
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });
});

// ─── Rotas de Autenticação ───────────────────────────────────────────────────────

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Usuário inválido' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Senha inválida' });
  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username: user.username });
});

// ─── Rotas REST ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendFile(path.join(process.cwd(), 'public', 'login.html'));
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendFile(path.join(process.cwd(), 'public', 'login.html'));
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  });
});

app.get('/status', authenticateToken, (req, res) => {
  res.json(clientStates);
});

app.get('/logs', authenticateToken, (req, res) => {
  res.json(serverLogs);
});

app.post('/add-account', authenticateToken, async (req, res) => {
  const { name, accountId } = req.body;
  if (!name || !accountId) return res.status(400).json({ error: 'Nome e ID são obrigatórios' });

  if (clients[accountId]) {
    return res.status(400).json({ error: 'Esta conexão já existe' });
  }

  console.log(`[${accountId}] Adicionando nova conta: ${name}`);
  accountNames[accountId] = name;
  if (!ACCOUNTS.includes(accountId)) ACCOUNTS.push(accountId);
  saveSessions();

  clientStates[accountId] = { status: 'starting', qr: null, ready: false, loadingPercent: 0, name: name, reason: null };
  clients[accountId] = createClient(accountId);

  io.emit('status_update', { accountId, ...clientStates[accountId] });

  clients[accountId].initialize().catch(err => {
    console.error(`[${accountId}] Erro na inicialização:`, err.message);
    clientStates[accountId].status = 'disconnected';
    clientStates[accountId].reason = err.message;
    io.emit('status_update', { accountId, ...clientStates[accountId] });
  });

  res.json({ ok: true });
});

app.post('/remove-account/:accountId', authenticateToken, async (req, res) => {
  const { accountId } = req.params;
  console.log(`[${accountId}] Removendo conta`);

  if (!ACCOUNTS.includes(accountId)) {
    return res.status(400).json({ error: 'Conexão não encontrada' });
  }

  try {
    if (clients[accountId]) {
      try { await clients[accountId].destroy(); } catch (_) { }
      delete clients[accountId];
    }
    delete clientStates[accountId];
    ACCOUNTS = ACCOUNTS.filter(id => id !== accountId);
    delete accountNames[accountId];
    saveSessions();

    const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `session-${accountId}`);
    if (await fs.pathExists(sessionPath)) {
      await fs.remove(sessionPath);
      console.log(`[${accountId}] Pasta de sessao removida`);
    }

    io.emit('account_removed', { accountId });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${accountId}] Erro ao remover:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/reconnect/:accountId', authenticateToken, async (req, res) => {
  const { accountId } = req.params;
  console.log(`[${accountId}] Reconexão solicitada`);

  try {
    if (clients[accountId]) {
      try { await clients[accountId].destroy(); } catch (_) { }
    }

    const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `session-${accountId}`);
    if (await fs.pathExists(sessionPath)) {
      await fs.remove(sessionPath);
      console.log(`[${accountId}] Pasta de sessao removida`);
    }

    clientStates[accountId] = { ...clientStates[accountId], status: 'starting', qr: null, ready: false, loadingPercent: 0, reason: null };
    clients[accountId] = createClient(accountId);

    io.emit('status_update', { accountId, ...clientStates[accountId] });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${accountId}] Erro ao reconectar:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate-qr/:accountId', authenticateToken, async (req, res) => {
  const { accountId } = req.params;
  console.log(`[${accountId}] Gerando novo QR Code...`);
  
  if (!clients[accountId]) {
    return res.status(400).json({ error: 'Conta não encontrada' });
  }
  
  if (clientStates[accountId]?.ready) {
    return res.status(400).json({ error: 'Já conectado' });
  }
  
  try {
    if (clients[accountId].pupPage) {
      try { await clients[accountId].pupPage.close(); } catch (_) { }
    }
    
    const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `session-${accountId}`);
    if (await fs.pathExists(sessionPath)) {
      await fs.remove(sessionPath);
    }
    
    clientStates[accountId] = { ...clientStates[accountId], status: 'starting', qr: null, ready: false, loadingPercent: 0, reason: null };
    delete clients[accountId];
    clients[accountId] = createClient(accountId);
    
    io.emit('status_update', { accountId, ...clientStates[accountId] });
    
    clients[accountId].initialize().catch(err => {
      console.error(`[${accountId}] Erro:`, err.message);
      clientStates[accountId].status = 'disconnected';
      clientStates[accountId].reason = err.message;
      io.emit('status_update', { accountId, ...clientStates[accountId] });
    });
    
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${accountId}] Erro ao gerar QR:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/chats', authenticateToken, async (req, res) => {
  try {
    const allResults = [];
    for (const id of ACCOUNTS) {
      if (!clientStates[id] || !clientStates[id].ready) continue;
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

app.get('/messages/:fullId', authenticateToken, async (req, res) => {
  try {
    const { accountId, chatId } = parseId(req.params.fullId);
    if (!clients[accountId] || !clientStates[accountId]?.ready) return res.status(503).json({ error: 'Offline' });
    const limit = parseInt(req.query.limit) || 50;
    const chat = await withRetry(() => clients[accountId].getChatById(chatId));
    const msgs = await withRetry(() => chat.fetchMessages({ limit }));
    try { await chat.sendSeen(); } catch (_) { }
    const msgsWithMedia = await Promise.all(msgs.map(async m => {
      let mediaUrl = null;
      if (m.hasMedia) {
        try {
          const media = await m.downloadMedia();
          if (media) {
            mediaUrl = `data:${media.mimetype};base64,${media.data}`;
          }
        } catch (_) {}
      }
      return {
        id: m.id._serialized,
        body: m.body || (m.hasMedia ? 'Midia' : ''),
        fromMe: m.fromMe,
        timestamp: m.timestamp,
        type: m.type,
        hasMedia: m.hasMedia,
        mediaUrl: mediaUrl,
        ack: m.ack,
      };
    }));
    res.json(msgsWithMedia);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/send', authenticateToken, async (req, res) => {
  try {
    const { to, body, mediaUrl, caption } = req.body;
    const { accountId, chatId } = parseId(to);
    if (!clients[accountId] || !clientStates[accountId]?.ready) return res.status(503).json({ error: 'Offline' });
    let msg;
    if (mediaUrl) {
      msg = await clients[accountId].sendMessage(chatId, caption || '', { media: mediaUrl });
    } else {
      msg = await clients[accountId].sendMessage(chatId, body);
    }
    res.json({ ok: true, id: msg.id._serialized });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/send-file', authenticateToken, async (req, res) => {
  try {
    const { to, file, caption, mimeType, fileName } = req.body;
    const { accountId, chatId } = parseId(to);
    if (!clients[accountId] || !clientStates[accountId]?.ready) return res.status(503).json({ error: 'Offline' });
    const base64Data = file.replace(/^data:[^;]+;base64,/, '');
    const media = new MessageMedia(mimeType || 'application/octet-stream', base64Data, fileName || 'file');
    const msg = await clients[accountId].sendMessage(chatId, media, { caption: caption || '' });
    res.json({ ok: true, id: msg.id._serialized });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/avatar/:fullId', authenticateToken, async (req, res) => {
  try {
    const { accountId, chatId } = parseId(req.params.fullId);
    if (!clients[accountId] || !clientStates[accountId]?.ready) return res.json({ url: null });
    const url = await clients[accountId].getProfilePicUrl(chatId).catch(() => null);
    res.json({ url: url || null });
  } catch (err) { res.json({ url: null }); }
});

app.get('/contact/:fullId', authenticateToken, async (req, res) => {
  try {
    const { accountId, chatId } = parseId(req.params.fullId);
    if (!clients[accountId] || !clientStates[accountId]?.ready) return res.status(503).json({ error: 'Offline' });
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
  ACCOUNTS.forEach((id, index) => {
    setTimeout(() => {
      const s = clientStates[id];
      if (s && s.status !== 'connected' && s.status !== 'initializing' && s.status !== 'loading') {
        console.log(`[${id}] Auto-inicializando...`);
        clientStates[id].status = 'initializing';
        io.emit('status_update', { accountId: id, ...clientStates[id] });
        clients[id].initialize().catch(err => {
          console.error(`[${id}] Erro:`, err.message);
          clientStates[id].status = 'disconnected';
          clientStates[id].reason = err.message;
          io.emit('status_update', { accountId: id, ...clientStates[id] });
        });
      }
    }, index * 8000);
  });
  console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
});
