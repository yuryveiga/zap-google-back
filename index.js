const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
const port = process.env.PORT || 3000;

// Estado global
let qrBase64 = null;
let status = "starting";

// Cliente WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './auth_info'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--no-zygote',
            '--single-process'
        ],
    }
});

// Evento QR
client.on('qr', async (qr) => {
    console.log('📲 QR Code gerado');

    try {
        qrBase64 = await QRCode.toDataURL(qr);
        status = "pending";
    } catch (err) {
        console.error('Erro ao gerar QR:', err);
    }
});

// Cliente pronto
client.on('ready', () => {
    console.log('✅ WhatsApp conectado!');
    status = "connected";
    qrBase64 = null;
});

// Falha de autenticação
client.on('auth_failure', msg => {
    console.error('❌ Falha na autenticação:', msg);
    status = "error";
});

// Desconectado
client.on('disconnected', reason => {
    console.log('⚠️ Desconectado:', reason);
    status = "disconnected";
});

// Endpoint QR
app.get('/get-qr', (req, res) => {
    res.json({
        status,
        qr: qrBase64
    });
});

// Healthcheck
app.get('/', (req, res) => {
    res.send('🚀 API WhatsApp rodando');
});

// Inicializa
client.initialize();

// Start server
app.listen(port, () => {
    console.log(`🌐 Servidor rodando na porta ${port}`);
});