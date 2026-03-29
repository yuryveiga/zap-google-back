const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

let lastQR = null;
let status = 'loading';

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: 'auth_info' }),
    puppeteer: {
        headless: true,
        // O Railway/Nixpacks geralmente instala nestes locais:
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' || '/usr/bin/google-chrome' || '/usr/bin/chromium-browser',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process',
            '--no-zygote'
        ],
    }
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    lastQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
    status = 'pending';
});

client.on('ready', () => {
    console.log('Client is ready!');
    status = 'connected';
    lastQR = null;
});

client.on('authenticated', () => {
    console.log('Authenticated');
});

client.initialize();

app.get('/get-qr', (req, res) => {
    res.json({ status: status, qrUrl: lastQR });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${port}`);
});