const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

let qrCodeBase64 = null;
let status = 'starting';

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
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

app.get('/', (req, res) => {
    res.send('🚀 API WhatsApp rodando');
});

app.get('/get-qr', (req, res) => {
    res.json({
        status,
        qr: qrCodeBase64
    });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});