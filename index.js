require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});
const PORT = process.env.PORT || 3000;

// --- Sistema de Logs com Monitoramento de RAM ---
const serverLogs = [];
const logToMemory = (level, ...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  const logEntry = {
    t: new Date().toISOString(),
    level,
    msg,
    freeMem: `${(os.freemem() / 1024 / 1024).toFixed(0)}MB`
  };
  serverLogs.push(logEntry);
  if (serverLogs.length > 200) serverLogs.shift();
  level === 'error' ? console.error(`[ERR] ${msg}`) : console.log(`[INFO] ${msg}`);
};

console.log = (...a) => logToMemory('info', ...a);
console.error = (...a) => logToMemory('error', ...a);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// --- Configuração de Sessões ---
const SESSIONS_FILE = path.join(process.cwd(), 'sessions.json');
let ACCOUNTS = [];
let accountNames = {};

if (fs.existsSync(SESSIONS_FILE)) {
  try {
    const data = fs.readJsonSync(SESSIONS_FILE);
    ACCOUNTS = data.accounts || ACCOUNTS;
    accountNames = data.names || accountNames;
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
  clientStates[id] = { status: 'starting', qr: null, ready: false, loadingPercent: 0, name: accountNames[id] || id };
});

// --- Fábrica de Clientes com Otimização de Recursos ---
function createClient(id) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--mute-audio',
        '--js-flags="--max-old-space-size=512"' // Limita heap de cada aba do Chromium
      ]
    }
  });

  client.on('qr', async (qr) => {
    const base64 = await qrcode.toDataURL(qr);
    clientStates[id] = { ...clientStates[id], qr: base64, status: 'pending', ready: false };
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('ready', () => {
    clientStates[id] = { ...clientStates[id], status: 'connected', ready: true, qr: null };
    console.log(`[${id}] Cliente pronto.`);
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('authenticated', () => {
    clientStates[id].status = 'authenticated';
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${id}] Falha na autenticação: ${msg}`);
    clientStates[id].status = 'disconnected';
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('loading_screen', (percent, message) => {
    clientStates[id] = { ...clientStates[id], status: 'loading', loadingPercent: percent };
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('disconnected', (reason) => {
    console.log(`[${id}] Desconectado: ${reason}`);
    clientStates[id] = { ...clientStates[id], status: 'disconnected', ready: false, qr: null };
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

// --- Helpers de Rede e Tempo ---
function parseId(fullId) {
  const parts = fullId.split(':');
  if (parts.length < 2) return { accountId: ACCOUNTS[0], chatId: fullId };
  return { accountId: parts[0], chatId: parts.slice(1).join(':') };
}

async function withTimeout(fn, ms = 15000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout após ' + ms + 'ms')), ms))
  ]);
}

async function withRetry(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try { return await withTimeout(fn); }
    catch (err) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay));
      else throw err;
    }
  }
}

// --- Socket.io ---
io.on('connection', (socket) => {
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
    } catch (err) { socket.emit('error', { message: err.message }); }
  });
});

// --- Rotas da API ---
app.get('/status', (req, res) => res.json(clientStates));
app.get('/logs', (req, res) => res.json(serverLogs));
app.get('/system-health', (req, res) => {
  res.json({
    freeMem: `${(os.freemem() / 1024 / 1024).toFixed(2)} MB`,
    uptime: `${(os.uptime() / 3600).toFixed(2)}h`,
    clients: Object.keys(clients).length
  });
});

app.post('/add-account', async (req, res) => {
  const { name, accountId } = req.body;
  if (!name || !accountId || clients[accountId]) return res.status(400).json({ error: 'ID inválido ou já existe' });

  accountNames[accountId] = name;
  if (!ACCOUNTS.includes(accountId)) ACCOUNTS.push(accountId);
  saveSessions();

  clientStates[accountId] = { status: 'starting', qr: null, ready: false, loadingPercent: 0, name: name };
  clients[accountId] = createClient(accountId);
  clients[accountId].initialize().catch(e => console.error(`[${accountId}] Erro: ${e.message}`));

  res.json({ ok: true });
});

app.post('/reset/:accountId', async (req, res) => {
  const { accountId } = req.params;
  try {
    if (clients[accountId]) await clients[accountId].destroy().catch(() => { });
    const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `session-${accountId}`);
    if (await fs.pathExists(sessionPath)) await fs.remove(sessionPath);

    clientStates[accountId] = { ...clientStates[accountId], status: 'starting', qr: null, ready: false };
    clients[accountId] = createClient(accountId);
    clients[accountId].initialize();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/chats', async (req, res) => {
  try {
    const allResults = [];
    for (const id of ACCOUNTS) {
      if (!clientStates[id]?.ready) continue;
      try {
        const chats = await withRetry(() => clients[id].getChats());
        allResults.push(...chats.slice(0, 40).map(c => ({
          id: `${id}:${c.id._serialized}`,
          name: c.name || c.id.user || '',
          isGroup: c.isGroup,
          unreadCount: c.unreadCount,
          accountId: id,
          lastMessage: c.lastMessage ? { body: c.lastMessage.body, timestamp: c.lastMessage.timestamp } : null
        })));
      } catch (e) { console.error(`Erro chats ${id}: ${e.message}`); }
    }
    res.json(allResults.sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/messages/:fullId', async (req, res) => {
  try {
    const { accountId, chatId } = parseId(req.params.fullId);
    const chat = await withRetry(() => clients[accountId].getChatById(chatId));
    const msgs = await withRetry(() => chat.fetchMessages({ limit: 50 }));
    res.json(msgs.map(m => ({ id: m.id._serialized, body: m.body, fromMe: m.fromMe, timestamp: m.timestamp })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Inicialização Sequencial ---
async function startSequentially() {
  console.log(`Iniciando ${ACCOUNTS.length} contas...`);
  for (const id of ACCOUNTS) {
    if (clientStates[id].status !== 'connected') {
      clients[id] = createClient(id);
      clients[id].initialize().catch(e => console.error(`[${id}] Falha: ${e.message}`));
      // Intervalo de 10s para não saturar a CPU no boot do Chromium
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  startSequentially();
});