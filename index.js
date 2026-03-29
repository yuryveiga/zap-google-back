const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const path = require('path');
const pino = require('pino');

const app = express();
app.use(cors());
const port = process.env.PORT || 3000;

let lastQR = null;
let isConnected = false;

async function connectToWhatsApp() {
    // Usando uma pasta limpa para garantir o QR Code
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // LOG DE DEBUG PARA VOCÊ VER NO RAILWAY
        console.log('Update de Conexão:', connection || 'Aguardando QR...');

        if (qr) {
            console.log(">>> QR CODE RECEBIDO DO WHATSAPP! <<<");
            lastQR = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
            isConnected = false;
        }

        if (connection === 'close') {
            const code = lastDisconnect.error?.output?.statusCode;
            console.log('Conexão fechada. Código:', code);
            isConnected = false;
            // Se não for logoff voluntário, tenta reconectar
            if (code !== DisconnectReason.loggedOut) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('SESSÃO ATIVA E PRONTA!');
            isConnected = true;
            lastQR = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// ROTA DE STATUS PARA O HTML
app.get('/get-qr', (req, res) => {
    if (isConnected) {
        return res.json({ status: "connected" });
    }
    if (lastQR) {
        return res.json({ status: "pending", qrUrl: lastQR });
    }
    res.json({ status: "loading", message: "Iniciando conexão..." });
});

// PÁGINA PRINCIPAL
app.get('/', (req, res) => {
    res.send(`
        <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f0f2f5;">
            <div style="background:white;padding:30px;border-radius:15px;box-shadow:0 4px-15px rgba(0,0,0,0.1);text-align:center;">
                <h2>Painel WhatsApp - Rio de Janeiro</h2>
                <div id="display">Carregando...</div>
            </div>
            <script>
                async function check() {
                    const r = await fetch('/get-qr');
                    const d = await r.json();
                    const div = document.getElementById('display');
                    if(d.status === 'connected') {
                        div.innerHTML = '<h1 style="color:green">✅ Conectado!</h1><p>Pronto para enviar mensagens.</p>';
                    } else if(d.status === 'pending') {
                        div.innerHTML = '<p>Escaneie agora:</p><img src="' + d.qrUrl + '" style="border:10px solid white;box-shadow:0 0 10px rgba(0,0,0,0.1)">';
                    } else {
                        div.innerHTML = '<p>Gerando novo QR Code... aguarde 5 segundos.</p>';
                    }
                }
                setInterval(check, 5000);
                check();
            </script>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log("Servidor Online na porta " + port);
    connectToWhatsApp();
});