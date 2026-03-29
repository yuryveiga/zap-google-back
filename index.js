const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// 1. FUNÇÃO DE BUSCA (Coloque aqui)
const getChromePath = () => {
    const paths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/app/.apt/usr/bin/google-chrome'
    ];
    for (const path of paths) {
        if (fs.existsSync(path)) {
            console.log(`✅ Chrome encontrado em: ${path}`);
            return path;
        }
    }
    console.error("❌ Nenhum binário do Chrome encontrado!");
    return null;
};

// 2. CONFIGURAÇÃO DO CLIENTE (Substitua o seu antigo por este)
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: 'auth_info' }),
    puppeteer: {
        headless: true,
        executablePath: getChromePath(), // Chama a função acima
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process',
            '--no-zygote'
        ],
    }
});

// ... resto do seu código (client.on('qr'), app.get, etc)