app.get('/chats', async (req, res) => {
  try {
    let allChats = [];
    for (const id of ACCOUNTS) {
      if (clientStates[id].ready) {
        // Tenta buscar os chats
        let chats = await clients[id].getChats();

        // Se a lista vier vazia, pode ser que o cache ainda esteja carregando
        // Tentamos um pequeno "retry" de 1 segundo se for a primeira carga
        if (chats.length === 0) {
          await new Promise(r => setTimeout(r, 1000));
          chats = await clients[id].getChats();
        }

        const mapped = chats
          .filter(c => !c.isGroup && !c.isReadOnly) // Filtra para mostrar apenas conversas úteis
          .slice(0, 40) // Limita para não travar o navegador
          .map(c => ({
            id: `${id}:${c.id._serialized}`,
            name: c.name || c.id.user,
            accountId: id,
            timestamp: c.timestamp
          }));
        allChats = allChats.concat(mapped);
      }
    }
    // Ordena por data (mais recentes primeiro)
    allChats.sort((a, b) => b.timestamp - a.timestamp);
    res.json(allChats);
  } catch (err) {
    console.error("Erro ao listar chats:", err);
    res.status(500).json({ error: 'Erro ao buscar conversas' });
  }
});