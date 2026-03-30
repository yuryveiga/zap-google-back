require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// Gerenciamento de instâncias (Máximo 2 conforme sua interface)
const ACCOUNTS = ['CONTA_01', 'CONTA_02'];
const clients = {};
const clientStates = {};

ACCOUNTS.forEach(id => {
  clientStates[id] = { status: 'disconnected', qr: null, ready: false };

  clients[id] = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  clients[id].on('qr', async (qr) => {
    clientStates[id].qr = await qrcode.toDataURL(qr);
    clientStates[id].status = 'qr';
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  clients[id].on('ready', () => {
    clientStates[id].ready = true;
    clientStates[id].status = 'connected';
    clientStates[id].qr = null;
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });
});

app.get('/status', (req, res) => res.json(clientStates));

app.get('/chats', async (req, res) => {
  try {
    let allChats = [];
    for (const id of ACCOUNTS) {
      if (clientStates[id].ready) {
        let chats = await clients[id].getChats();
        // Delay de sincronização se necessário
        if (chats.length === 0) {
          await new Promise(r => setTimeout(r, 2000));
          chats = await clients[id].getChats();
        }
        const mapped = chats.filter(c => !c.isGroup).slice(0, 40).map(c => ({
          id: `${id}:${c.id._serialized}`,
          name: c.name || c.id.user,
          accountId: id,
          timestamp: c.timestamp
        }));
        allChats = allChats.concat(mapped);
      }
    }
    allChats.sort((a, b) => b.timestamp - a.timestamp);
    res.json(allChats);
  } catch (err) { res.status(500).json({ error: 'Erro nos chats' }); }
});

app.post('/init-instance', (req, res) => {
  const { id } = req.body;
  if (clients[id]) {
    clients[id].initialize().catch(() => { });
    res.json({ success: true });
  } else {
    res.status(404).send();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor online na porta ${PORT}`);
});