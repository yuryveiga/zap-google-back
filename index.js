const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
let lastQR = null;

async function connectToWhatsApp() {
    // Railway salva arquivos na pasta /auth_info se configurarmos o Volume
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true // Também imprime no log do Railway
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            // Aqui geramos a URL usando a API do QRServer
            lastQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('Conexão aberta com sucesso!');
            lastQR = null; // QR não é mais necessário
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Endpoint para o seu Frontend consumir
app.get('/get-qr', (req, res) => {
    if (lastQR) {
        res.json({ status: "pending", qrUrl: lastQR });
    } else {
        res.json({ status: "connected", message: "WhatsApp já está conectado ou aguardando geração." });
    }
});

app.listen(port, () => {
    console.log(`Backend rodando na porta ${port}`);
    connectToWhatsApp();
});