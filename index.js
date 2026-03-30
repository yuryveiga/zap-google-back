require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs-extra');

// --- INICIALIZAÇÃO CORE ---
const app = express(); // DEFINIÇÃO DO APP (IMPORTANTE!)
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// --- CONFIGURAÇÃO DE CONTAS ---
const ACCOUNTS = ['CONTA_01', 'CONTA_02'];
const clients = {};
const clientStates = {};

ACCOUNTS.forEach(id => {
  clientStates[id] = { status: 'disconnected', qr: null, ready: false, name: id };

  clients[id] = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    }
  });

  clients[id].on('qr', async (qr) => {
    const url = await qrcode.toDataURL(qr);
    clientStates[id].qr = url;
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

// --- ROTAS DA API ---
app.get('/status', (req, res) => res.json(clientStates));

app.get('/chats', async (req, res) => {
  try {
    let allChats = [];
    for (const id of ACCOUNTS) {
      if (clientStates[id]?.ready) {
        let chats = await clients[id].getChats();

        // Retry para sincronização inicial
        if (chats.length === 0) {
          await new Promise(r => setTimeout(r, 2000));
          chats = await clients[id].getChats();
        }

        const mapped = chats
          .filter(c => !c.isGroup)
          .slice(0, 40)
          .map(c => ({
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
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar conversas' });
  }
});

// Inicialização
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  ACCOUNTS.forEach((id, index) => {
    setTimeout(() => clients[id].initialize(), index * 5000);
  });
});