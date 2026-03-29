app.get('/qr', (req, res) => {
    if (!qrCodeBase64) {
        return res.send('<h2>QR ainda não gerado. Aguarde...</h2>');
    }

    res.send(`
    <html>
      <head>
        <title>QR Code WhatsApp</title>
      </head>
      <body style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;">
        <h2>Escaneie o QR Code</h2>
        <img src="${qrCodeBase64}" />
        <p>Status: ${status}</p>
      </body>
    </html>
  `);
});