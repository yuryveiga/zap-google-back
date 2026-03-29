const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());

// Esta linha faz o Express servir o index.html que estiver na pasta 'public'
app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 3000;
let lastQR = null;
let isConnected = false;

async function connectToWhatsApp() {
    // Persistência na pasta auth_info (configure o Volume no Railway para este caminho)
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            lastQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
            isConnected = false;
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('Conexão aberta com sucesso!');
            isConnected = true;
            lastQR = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Rota que o seu HTML vai consultar internamente
app.get('/get-qr', (req, res) => {
    if (isConnected) return res.json({ status: "connected" });
    if (lastQR) return res.json({ status: "pending", qrUrl: lastQR });
    res.json({ status: "loading" });
});

app.listen(port, () => {
    console.log(`Backend rodando na porta ${port}`);
    connectToWhatsApp();
});