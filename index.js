require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs-extra');

// 1. INICIALIZAÇÃO DO EXPRESS (Deve vir antes das rotas)
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

// 2. MIDDLEWARES
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// 3. CONFIGURAÇÃO DAS CONTAS
const ACCOUNTS = ['CONTA_01', 'CONTA_02']; // Ajuste os IDs conforme sua necessidade
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
    console.log(`[${id}] Cliente pronto!`);
    io.emit('status_update', { accountId: id, ...clientStates[id] });
  });

  clients[id].on('change_state', state => {
    console.log(`[${id}] Estado alterado:`, state);
  });
});

// 4. ROTAS DA API
app.get('/status', (req, res) => res.json(clientStates));

app.get('/chats', async (req, res) => {
  try {
    let allChats = [];
    for (const id of ACCOUNTS) {
      if (clientStates[id] && clientStates[id].ready) {
        let chats = await clients[id].getChats();

        // Se a lista vier vazia (comum no primeiro login), espera 2 segundos e tenta de novo
        if (chats.length === 0) {
          await new Promise(r => setTimeout(r, 2000));
          chats = await clients[id].getChats();
        }

        const mapped = chats
          .filter(c => !c.isGroup)
          .slice(0, 50)
          .map(c => ({
            id: `${id}:${c.id._serialized}`,
            name: c.name || c.id.user,
            accountId: id,
            timestamp: c.timestamp
          }));
        allChats = allChats.concat(mapped);
      }
    }
    // Ordenar por mensagens mais recentes
    allChats.sort((a, b) => b.timestamp - a.timestamp);
    res.json(allChats);
  } catch (err) {
    console.error("Erro ao carregar chats:", err);
    res.status(500).json({ error: 'Erro ao buscar conversas' });
  }
});

app.post('/send', async (req, res) => {
  const { to, body } = req.body;
  try {
    const [accountId, chatId] = to.split(':');
    if (clients[accountId] && clientStates[accountId].ready) {
      await clients[accountId].sendMessage(chatId, body);
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'Conta não conectada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. INICIALIZAÇÃO DO SERVIDOR
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor a correr na porta ${PORT}`);
  ACCOUNTS.forEach((id, index) => {
    setTimeout(() => {
      console.log(`[${id}] Inicializando...`);
      clients[id].initialize().catch(err => console.error(`Erro em ${id}:`, err));
    }, index * 5000); // Intervalo de 5s entre inicializações para evitar sobrecarga
  });
});