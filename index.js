const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

let qrCodeBase64 = null;
let clientReady = false;

// Cliente WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Evento QR
client.on('qr', async (qr) => {
  console.log('📱 QR RECEBIDO');

  qrCodeBase64 = await QRCode.toDataURL(qr);
});

// Evento pronto
client.on('ready', () => {
  console.log('✅ WhatsApp conectado');
  clientReady = true;
});

// Evento desconectado
client.on('disconnected', () => {
  console.log('❌ WhatsApp desconectado');
  clientReady = false;
});

// Inicializa
client.initialize();


// =============================
// ROTAS
// =============================

// Home
app.get('/', (req, res) => {
  res.send('🚀 API WhatsApp rodando');
});


// Status + QR (JSON)
app.get('/qr', (req, res) => {
  if (clientReady) {
    return res.json({ status: 'ready' });
  }

  if (!qrCodeBase64) {
    return res.json({ status: 'loading' });
  }

  res.json({
    status: 'pending',
    qr: qrCodeBase64
  });
});


// QR como imagem (abre no navegador)
app.get('/qr-image', (req, res) => {
  if (!qrCodeBase64) {
    return res.send('QR ainda não gerado');
  }

  const img = Buffer.from(
    qrCodeBase64.replace(/^data:image\/png;base64,/, ''),
    'base64'
  );

  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': img.length
  });

  res.end(img);
});


// ENVIO DE MENSAGEM
app.post('/send', async (req, res) => {
  const { number, message } = req.body;

  if (!clientReady) {
    return res.status(400).json({
      error: 'WhatsApp não conectado'
    });
  }

  if (!number || !message) {
    return res.status(400).json({
      error: 'Número e mensagem são obrigatórios'
    });
  }

  try {
    const chatId = number + '@c.us';

    await client.sendMessage(chatId, message);

    res.json({
      status: 'enviado',
      number,
      message
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});


// PORTA (Railway usa PORT automático)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});