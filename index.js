const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express(); // ✅ TEM QUE VIR ANTES
const PORT = process.env.PORT || 3000;

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

client.on('qr', async (qr) => {
  console.log('QR gerado');
  qrCodeBase64 = await qrcode.toDataURL(qr);
  status = 'pending';
});

client.on('ready', () => {
  console.log('WhatsApp conectado');
  status = 'connected';
  qrCodeBase64 = null;
});

client.on('disconnected', () => {
  console.log('WhatsApp desconectado');
  status = 'disconnected';
});

client.initialize();


// ✅ ROTAS (AGORA SIM depois do app)

app.get('/', (req, res) => {
  res.send('🚀 API WhatsApp rodando');
});

app.get('/get-qr', (req, res) => {
  res.json({
    status,
    qr: qrCodeBase64
  });
});

app.get('/qr', (req, res) => {
  if (!qrCodeBase64) {
    return res.send('<h2>QR ainda não gerado...</h2>');
  }

  res.setHeader('Content-Type', 'text/html');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>QR WhatsApp</title>
        <meta charset="UTF-8" />
        <meta http-equiv="refresh" content="5">
      </head>
      <body style="text-align:center;font-family:Arial;">
        <h2>Escaneie o QR Code</h2>
        <img src="${qrCodeBase64}" style="width:300px;height:300px;" />
        <p>Status: ${status}</p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});