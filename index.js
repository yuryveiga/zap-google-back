const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors'); // <--- PARTE 2: Importação
const path = require('path');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

// <--- PARTE 2: Ativação do CORS
app.use(cors());

let lastQR = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_teste'));
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            // Gera a URL do QRServer
            lastQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('Conectado!');
            lastQR = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// <--- PARTE 2: Rota para entregar o HTML (Página Principal)
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Zap QR Connect</title>
            <style>
                body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #f0f2f5; }
                .card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
                img { margin-top: 20px; border: 1px solid #ddd; padding: 10px; border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>Conectar WhatsApp</h2>
                <div id="status">Buscando QR Code...</div>
                <div id="qr"></div>
            </div>
            <script>
                async function update() {
                    try {
                        const r = await fetch('/get-qr');
                        const d = await r.json();
                        if(d.status === 'pending') {
                            document.getElementById('qr').innerHTML = '<img src="' + d.qrUrl + '">';
                            document.getElementById('status').innerText = 'Aguardando leitura...';
                        } else {
                            document.getElementById('qr').innerHTML = '<h1 style="color:green">✅</h1>';
                            document.getElementById('status').innerText = 'WhatsApp Conectado!';
                        }
                    } catch(e) { console.error("Erro na API"); }
                }
                setInterval(update, 5000);
                update();
            </script>
        </body>
        </html>
    `);
});

// Rota JSON que o HTML consome
app.get('/get-qr', (req, res) => {
    if (lastQR) {
        res.json({ status: "pending", qrUrl: lastQR });
    } else {
        res.json({ status: "connected" });
    }
});

app.listen(port, () => {
    console.log("Servidor rodando na porta " + port);
    connectToWhatsApp();
});