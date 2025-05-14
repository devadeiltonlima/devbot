// start.js
// Script para rodar o bot com reinício automático usando nodemon
const { spawn } = require('child_process');

// Inicia o bot com nodemon (monitora alterações e reinicia automaticamente)
const bot = spawn(/^win/.test(process.platform) ? 'npx.cmd' : 'npx', [
  'nodemon', 
  '--verbose', // Adiciona mais detalhes no console
  '--watch', '.', // Observa toda a pasta atual
  '--ignore', 'downloads/,auth_info_baileys/', // Ignora pastas específicas
  'index.js'
], {
  stdio: 'inherit',
});

// Não inicia o Python diretamente, pois ele precisa de argumentos
// Para reiniciar o bot, basta fazer alterações em qualquer arquivo .js

bot.on('close', (code) => {
  console.log(`Bot finalizado com código ${code}`);
  process.exit(code);
});
