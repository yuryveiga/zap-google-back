require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const http    = require('http');
const { Server }           = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path   = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const PORT   = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// ─── Estado ───────────────────────────────────────────────────────────────────
const SLOTS = ['CONTA_01', 'CONTA_02'];
const clients      = {};   // id -> Client
const clientStates = {};   // id -> { status, qr, ready, name }

SLOTS.forEach(id => {
  clientStates[id] = { status: 'empty', qr: null, ready: false, name: null };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function emit(id) {
  io.emit('status_update', { accountId: id, ...clientStates[id] });
}

function createClient(id) {
  // Destrói instância anterior se existir
  if (clients[id]) {
    try { clients[id].destroy(); } catch (_) {}
    delete clients[id];
  }

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
        '--single-process',
      ],
    }
  });

  client.on('loading_screen', (percent, msg) => {
    console.log(`[${id}] ${percent}% - ${msg}`);
    clientStates[id].status = 'loading';
    clientStates[id].loadingPercent = percent;
    emit(id);
  });

  client.on('authenticated', () => {
    console.log(`[${id}] Autenticado`);
    clientStates[id].status = 'authenticated';
    emit(id);
  });

  client.on('qr', async (qr) => {
    console.log(`[${id}] QR gerado`);
    clientStates[id].qr     = await qrcode.toDataURL(qr);
    clientStates[id].status = 'qr';
    emit(id);
  });

  client.on('ready', () => {
    console.log(`[${id}] Conectado`);
    clientStates[id].status = 'connected';
    clientStates[id].ready  = true;
    clientStates[id].qr     = null;
    emit(id);
  });

  client.on('auth_failure', msg => {
    console.error(`[${id}] Auth failure:`, msg);
    clientStates[id].status = 'disconnected';
    clientStates[id].ready  = false;
    emit(id);
  });

  client.on('disconnected', reason => {
    console.log(`[${id}] Desconectado:`, reason);
    clientStates[id].status = 'disconnected';
    clientStates[id].ready  = false;
    clientStates[id].qr     = null;
    emit(id);
  });

  clients[id] = client;
  return client;
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.get('/status', (req, res) => res.json(clientStates));

// Inicializa uma instância (cria o cliente sob demanda)
app.post('/init-instance', async (req, res) => {
  const { id, name } = req.body;
  if (!SLOTS.includes(id)) {
    return res.status(400).json({ error: 'ID invalido. Use: ' + SLOTS.join(', ') });
  }

  // Salva o nome
  clientStates[id].name   = name || clientStates[id].name || id;
  clientStates[id].status = 'starting';
  clientStates[id].qr     = null;
  clientStates[id].ready  = false;
  emit(id);

  // Cria e inicializa o cliente
  const client = createClient(id);
  client.initialize().catch(err => {
    console.error(`[${id}] Erro ao inicializar:`, err.message);
    clientStates[id].status = 'disconnected';
    emit(id);
  });

  res.json({ ok: true });
});

// Remove uma conexão completamente
app.post('/remove/:id', async (req, res) => {
  const { id } = req.params;
  if (!SLOTS.includes(id)) return res.status(400).json({ error: 'ID invalido' });

  try {
    if (clients[id]) {
      await clients[id].destroy().catch(() => {});
      delete clients[id];
    }
    clientStates[id] = { status: 'empty', qr: null, ready: false, name: null };
    emit(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reseta sessão (mantém o nome, gera novo QR)
app.post('/reset/:id', async (req, res) => {
  const { id } = req.params;
  if (!SLOTS.includes(id)) return res.status(400).json({ error: 'ID invalido' });

  const name = clientStates[id].name;
  try {
    if (clients[id]) {
      await clients[id].destroy().catch(() => {});
      delete clients[id];
    }
    clientStates[id] = { status: 'starting', qr: null, ready: false, name };
    emit(id);

    const client = createClient(id);
    client.initialize().catch(err => {
      console.error(`[${id}] Erro no reset:`, err.message);
      clientStates[id].status = 'disconnected';
      emit(id);
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chats
app.get('/chats', async (req, res) => {
  try {
    let allChats = [];
    for (const id of SLOTS) {
      if (!clientStates[id].ready) continue;
      try {
        let chats = await clients[id].getChats();
        if (!chats.length) {
          await new Promise(r => setTimeout(r, 2000));
          chats = await clients[id].getChats();
        }
        const mapped = chats.slice(0, 40).map(c => ({
          id: `${id}:${c.id._serialized}`,
          name: c.name || c.id.user,
          accountId: id,
          timestamp: c.lastMessage?.timestamp || 0,
        }));
        allChats = allChats.concat(mapped);
      } catch (e) { console.error(`[${id}] Erro getChats:`, e.message); }
    }
    allChats.sort((a, b) => b.timestamp - a.timestamp);
    res.json(allChats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Socket ───────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[Socket] conectado');
  SLOTS.forEach(id => socket.emit('status_update', { accountId: id, ...clientStates[id] }));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor online na porta ${PORT}`);
});
