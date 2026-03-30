require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs-extra');
const os = require('os'); // Adicionado para monitorar RAM

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

// --- Sistema de Logs Aprimorado ---
const serverLogs = [];
const logToMemory = (level, ...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  const logEntry = {
    t: new Date().toISOString(),
    level,
    msg,
    freeMem: `${(os.freemem() / 1024 / 1024).toFixed(0)}MB` // Loga memória livre
  };
  serverLogs.push(logEntry);
  if (serverLogs.length > 200) serverLogs.shift();
  level === 'error' ? console.error(msg) : console.log(msg);
};

console.log = (...a) => logToMemory('info', ...a);
console.error = (...a) => logToMemory('error', ...a);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// --- Configurações de Sessão ---
const SESSIONS_FILE = path.join(process.cwd(), 'sessions.json');
let ACCOUNTS = ['acc1', 'acc2'];
let accountNames = { 'acc1': 'WhatsApp 1', 'acc2': 'WhatsApp 2' };

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

// --- Fábrica de Clientes com Otimização de RAM ---
function createClient(id) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      // Configurações agressivas para reduzir consumo de RAM
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
        '--disable-setuid-sandbox',
        '--js-flags="--max-old-space-size=512"' // Limita heap de JS no Chromium
      ]
    }
  });

  // Eventos de Log e Estado (Mantidos e otimizados)
  client.on('qr', async (qr) => {
    const base64 = await qrcode.toDataURL(qr);
    clientStates[id] = { ...clientStates[id], qr: base64, status: 'pending', ready: false };
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('ready', () => {
    clientStates[id] = { ...clientStates[id], status: 'connected', ready: true, qr: null };
    console.log(`[${id}] Conectado com sucesso.`);
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${id}] Falha Crítica: ${msg}. Verifique a memória disponível.`);
    clientStates[id].status = 'disconnected';
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  // ... (demais eventos de mensagem permanecem iguais)
  return client;
}

// --- Inicialização Sequencial Inteligente ---
async function startClientsSequentially() {
  console.log(`Iniciando ${ACCOUNTS.length} contas. Memória Livre: ${(os.freemem() / 1024 / 1024).toFixed(0)}MB`);

  for (const id of ACCOUNTS) {
    try {
      clients[id] = createClient(id);
      console.log(`[${id}] Lançando navegador...`);

      await clients[id].initialize();

      // Aguarda 10 segundos antes de abrir o próximo para não sobrecarregar a CPU
      await new Promise(resolve => setTimeout(resolve, 10000));
    } catch (err) {
      console.error(`[${id}] Falha ao inicializar: ${err.message}`);
    }
  }
}

// --- Endpoints Adicionais de Diagnóstico ---
app.get('/system-health', (req, res) => {
  res.json({
    freeMem: `${(os.freemem() / 1024 / 1024).toFixed(2)} MB`,
    totalMem: `${(os.totalmem() / 1024 / 1024).toFixed(2)} MB`,
    uptime: `${(os.uptime() / 3600).toFixed(2)} horas`,
    activeClients: Object.keys(clients).length
  });
});

// --- Inicialização do Servidor ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
  startClientsSequentially(); // Chama a nova função sequencial
});