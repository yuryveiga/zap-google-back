const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
const port = process.env.PORT || 3000;

// Estado global
let qrBase64 = null;
let status = "loading";

// Cliente WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: 'auth_info' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process',
            '--no-zygote'
        ],
    }
});

// Evento QR
client.on('qr', async (qr) => {
    console.log('📲 QR Code gerado');

    qrBase64 = await QRCode.toDataURL(qr);
    status = "pending";
});

// Evento pronto
client.on('ready', () => {
    console.log('✅ WhatsApp conectado!');
    status = "connected";
});

// Evento erro
client.on('auth_failure', msg => {
    console.error('❌ Falha na autenticação:', msg);
    status = "error";
});

// Endpoint para frontend
app.get('/get-qr', (req, res) => {
    res.json({
        status,
        qrUrl: qrBase64
    });
});

// Healthcheck
app.get('/', (req, res) => {
    res.send('🚀 WhatsApp API rodando');
});

// Inicializa cliente
client.initialize();

// Start server
app.listen(port, () => {
    console.log(`🌐 Servidor rodando na porta ${port}`);
});