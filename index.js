// Importações principais
const crypto = require('crypto');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const pino = require('pino');
const logger = pino({ level: 'error' });
console.log('Iniciando o bot...');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const sharp = require('sharp');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const emojiApi = require('emoji-api');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const { spawn } = require('child_process');
const path = require('path');
const { transcreverAudio } = require('./google-speech');
const tempDir = path.join(__dirname, 'temp');

// Cria o diretório temp se não existir
fs.ensureDirSync(tempDir);

// Limpa o diretório temp a cada hora
setInterval(async () => {
    try {
        const files = await fs.readdir(tempDir);
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            const stats = await fs.stat(filePath);
            const age = Date.now() - stats.mtimeMs;
            // Remove arquivos com mais de 1 hora
            if (age > 3600000) {
                await fs.remove(filePath);
            }
        }
    } catch (error) {
        console.error('Erro ao limpar diretório temp:', error);
    }
}, 3600000); // 1 hora

// Função para processar TikTok usando Python
async function processarTikTok(url, tipo = 'video') {
    return new Promise((resolve, reject) => {
        const pythonScript = path.join(__dirname, 'tiktok_downloader.py');
        console.log(`Executando: python ${pythonScript} ${url} ${tipo}`);
        
        const python = spawn('python', [pythonScript, url, tipo]);
        
        let output = '';
        let error = '';

        python.stdout.on('data', (data) => {
            output += data.toString();
            console.log('Saída do Python:', data.toString());
        });

        python.stderr.on('data', (data) => {
            error += data.toString();
            console.error('Erro do Python:', data.toString());
        });

        python.on('close', (code) => {
            console.log(`Python encerrou com código: ${code}`);
            
            if (code !== 0) {
                console.error('Erro no script Python:', error);
                reject(new Error('Falha ao processar o vídeo do TikTok'));
                return;
            }

            try {
                console.log('Saída completa do Python:', output);
                const result = JSON.parse(output);
                console.log('Resultado processado:', result);
                resolve(result);
            } catch (e) {
                console.error('Erro ao processar saída do Python:', e);
                reject(e);
            }
        });
    });
}

// ====== AUTENTICAÇÃO E LIMITE DE USO ======
const pathUsuarios = './usuarios.json';

function carregarUsuarios() {
    if (!fs.existsSync(pathUsuarios)) return {};
    return JSON.parse(fs.readFileSync(pathUsuarios));
}
function salvarUsuarios(usuarios) {
    fs.writeFileSync(pathUsuarios, JSON.stringify(usuarios, null, 2));
}
function gerarCodigo() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
// ==========================================

// Função para criar figurinha de imagem
async function criarFigurinhaImagem(sock, msg) {
    // Tenta pegar a imagem direto ou de uma resposta (quoted)
    let imageMsg = msg.message.imageMessage ||
        msg.message.documentMessage ||
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
    let quotedMsg = msg;
    if (!msg.message.imageMessage && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
        quotedMsg = {
            ...msg,
            message: msg.message.extendedTextMessage.contextInfo.quotedMessage
        };
    }
    if (!imageMsg) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Envie ou responda uma imagem com o comando !fig.' }, { quoted: msg });
        await reagirMensagem(sock, msg, '❌');
        return;
    }
    try {
        const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, { reuploadRequest: sock });
        const stickerBuffer = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp()
            .toBuffer();
        await sock.sendMessage(msg.key.remoteJid, { sticker: stickerBuffer }, { quoted: msg });
        await reagirMensagem(sock, msg, '✅');
    } catch (e) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Erro ao criar figurinha. Tente novamente.' }, { quoted: msg });
        await reagirMensagem(sock, msg, '❌');
    }
}

// Função para criar figurinha animada de gif
async function criarFigurinhaGif(sock, msg) {
    // Tenta pegar o gif direto ou de uma resposta (quoted)
    let videoMsg = msg.message.videoMessage ||
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage;
    let quotedMsg = msg;
    if (!msg.message.videoMessage && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage) {
        quotedMsg = {
            ...msg,
            message: msg.message.extendedTextMessage.contextInfo.quotedMessage
        };
    }
    if (!videoMsg || !videoMsg.gifPlayback) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Responda a um GIF com o comando !gif.' }, { quoted: msg });
        await reagirMensagem(sock, msg, '❌');
        return;
    }
    try {
        const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, { reuploadRequest: sock });
        const tempInput = './temp_input.mp4';
        const tempOutput = './temp_output.webp';
        await fs.writeFile(tempInput, buffer);
        await new Promise((resolve, reject) => {
            ffmpeg(tempInput)
                .outputOptions([
                    '-vcodec', 'libwebp',
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15',
                    '-loop', '0',
                    '-ss', '0',
                    '-t', '8',
                    '-preset', 'default',
                    '-an', '-vsync', '0'
                ])
                .toFormat('webp')
                .save(tempOutput)
                .on('end', resolve)
                .on('error', reject);
        });
        const stickerBuffer = await fs.readFile(tempOutput);
        await sock.sendMessage(msg.key.remoteJid, { sticker: stickerBuffer }, { quoted: msg });
        await fs.remove(tempInput);
        await fs.remove(tempOutput);
        await reagirMensagem(sock, msg, '✅');
    } catch (e) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Erro ao criar figurinha animada. Tente novamente.' }, { quoted: msg });
        await reagirMensagem(sock, msg, '❌');
    }
}

// Função para gerar QR Code
async function gerarQRCode(sock, msg, texto) {
    try {
        const qrBuffer = await qrcode.toBuffer(texto, { type: 'png' });
        await sock.sendMessage(msg.key.remoteJid, { image: qrBuffer, caption: 'Aqui está seu QR Code!' }, { quoted: msg });
        await reagirMensagem(sock, msg, '✅');
    } catch (e) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Erro ao gerar QR Code. Tente novamente.' }, { quoted: msg });
        await reagirMensagem(sock, msg, '❌');
    }
}

// Função para adicionar texto em figurinha (simples)
async function figComTexto(sock, msg, texto) {
    // Procura a figurinha em mensagem direta ou reply
    let stickerMsg = msg.message.stickerMessage ||
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage;
    let quotedMsg = msg;
    if (!msg.message.stickerMessage && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage) {
        quotedMsg = {
            ...msg,
            message: msg.message.extendedTextMessage.contextInfo.quotedMessage
        };
    }
    if (!stickerMsg) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Responda a uma figurinha com !figtxt seu texto.' }, { quoted: msg });
        await reagirMensagem(sock, msg, '❌');
        return;
    }
    try {
        const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, { reuploadRequest: sock });
        const stickerBuffer = await sharp(buffer)
            .resize(512, 512)
            .composite([{ input: Buffer.from(`<svg width="512" height="512"><text x="50%" y="90%" font-size="60" fill="white" text-anchor="middle" font-family="Arial" stroke="black" stroke-width="3">${texto}</text></svg>`), top: 0, left: 0 }])
            .webp()
            .toBuffer();
        await sock.sendMessage(msg.key.remoteJid, { sticker: stickerBuffer }, { quoted: msg });
        await reagirMensagem(sock, msg, '✅');
    } catch (e) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Erro ao adicionar texto na figurinha.' }, { quoted: msg });
        await reagirMensagem(sock, msg, '❌');
    }
}

// Função para combinar emojis (usando API externa)
async function combinarEmojis(sock, msg, emojisText) {
    try {
        // Extrai todos os emojis do texto, ignorando espaços, símbolos e o caractere +
        const emojiRegex = /(\p{Emoji})/gu; // Regex Unicode moderno para emojis
        // Remove caracteres + para garantir que "emoji1 + emoji2" seja tratado corretamente
        const textoCleaned = emojisText.replace(/\+/g, ' ');
        const emojisArray = (textoCleaned.match(emojiRegex) || []).filter(e => e.trim() !== '');

        if (emojisArray.length < 2) {
            await sock.sendMessage(msg.key.remoteJid, { text: 'Envie pelo menos dois emojis após !emoji, como "!emoji 😊❤️" ou "!emoji 😊 + ❤️"' }, { quoted: msg });
            await reagirMensagem(sock, msg, '❌');
            return;
        }

        const emoji1 = emojisArray[0];
        const emoji2 = emojisArray[1];
        
        // Use um método seguro para exibir emojis no console
        const emoji1Hex = [...emoji1].map(c => c.codePointAt(0).toString(16)).join(' ');
        const emoji2Hex = [...emoji2].map(c => c.codePointAt(0).toString(16)).join(' ');
        console.log(`Tentando combinar emojis: ${emoji1} e ${emoji2} (hex: ${emoji1Hex}, ${emoji2Hex})`);

        // Datas do Emoji Kitchen em ordem cronológica reversa (mais recentes primeiro)
        const kitchenDates = [
            '20230418', '20230301', '20220823', '20220203', '20210521', '20210218', '20201001'
        ];

        let buffer = null;
        
        // Função para converter emoji para formato de URL da Emoji Kitchen
        function emojiToUrlFormat(emoji) {
            // Pega o code point e converte para hexadecimal
            return `u${emoji.codePointAt(0).toString(16).padStart(4, '0')}`;
        }

        // Tenta todas as datas, primeiro emoji1 + emoji2, depois emoji2 + emoji1
        for (const date of kitchenDates) {
            try {
                const emoji1Code = emojiToUrlFormat(emoji1);
                const emoji2Code = emojiToUrlFormat(emoji2);
                
                const url = `https://www.gstatic.com/android/keyboard/emojikitchen/${date}/${emoji1Code}/${emoji1Code}_${emoji2Code}.png`;
                console.log(`Tentando URL: ${url}`);
                
                // Use node-fetch com importação correta
                const res = await fetch(url);
                if (res.ok) {
                    buffer = await res.buffer();
                    console.log('URL funcionou!');
                    break;
                }
            } catch (e) { 
                console.log('Erro ao buscar combinação 1:', e.message);
                continue; 
            }
        }

        // Se não encontrou, tenta na ordem inversa
        if (!buffer) {
            for (const date of kitchenDates) {
                try {
                    const emoji1Code = emojiToUrlFormat(emoji1);
                    const emoji2Code = emojiToUrlFormat(emoji2);
                    
                    const url = `https://www.gstatic.com/android/keyboard/emojikitchen/${date}/${emoji2Code}/${emoji2Code}_${emoji1Code}.png`;
                    console.log(`Tentando URL invertida: ${url}`);
                    
                    // Use node-fetch com importação correta
                    const res = await fetch(url);
                    if (res.ok) {
                        buffer = await res.buffer();
                        console.log('URL invertida funcionou!');
                        break;
                    }
                } catch (e) { 
                    console.log('Erro ao buscar combinação 2:', e.message);
                    continue; 
                }
            }
        }

        if (buffer) {
            await sock.sendMessage(msg.key.remoteJid, {
                image: buffer,
                caption: `Combinação de ${emoji1} + ${emoji2}\nEnviando como imagem e figurinha!`
            }, { quoted: msg });

            const stickerBuffer = await sharp(buffer)
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp()
                .toBuffer();

            await sock.sendMessage(msg.key.remoteJid, { sticker: stickerBuffer }, { quoted: msg });
            await reagirMensagem(sock, msg, '✅');
        } else {
            await sock.sendMessage(msg.key.remoteJid, {
                text: `Não foi possível combinar ${emoji1} com ${emoji2}. Tente outra combinação de emojis.`
            }, { quoted: msg });
            await reagirMensagem(sock, msg, '❌');
        }
    } catch (error) {
        console.error('Erro ao combinar emojis:', error);
        await sock.sendMessage(msg.key.remoteJid, {
            text: 'Ocorreu um erro ao combinar os emojis. Tente outra combinação.'
        }, { quoted: msg });
        await reagirMensagem(sock, msg, '❌');
    }
}

// Função para reagir a uma mensagem com emoji
async function reagirMensagem(sock, msg, emoji) {
    await sock.sendMessage(msg.key.remoteJid, {
        react: {
            text: emoji, // ✅ ou ❌
            key: msg.key
        }
    });
}

// A função transcreverAudio agora é importada do google-speech.js

async function connectToWhatsApp() {
    try {
        console.log('Carregando credenciais...');
        const { version } = await fetchLatestBaileysVersion();
        console.log('Usando versão:', version);
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ['AdeBot', 'Chrome', '1.0.0'],
            version,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            retryRequestDelayMs: 2000,
            markOnlineOnConnect: true,
            syncFullHistory: true,
            fireInitQueries: true,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            linkPreviewImageThumbnailWidth: 192,
            transactionOpts: {
                maxCommitRetries: 10,
                delayBetweenTriesMs: 3000
            },
            getMessage: async key => {
                if(store) {
                    const msg = await store.loadMessage(key.remoteJid, key.id);
                    return msg?.message || undefined;
                }
                return { conversation: 'Mensagem não encontrada' };
            }
        });

        const store = {};
        
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            console.log('Status da conexão:', connection);

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log('Conexão fechada devido a:', lastDisconnect?.error?.message);
                console.log('Código de status:', statusCode);
                console.log('Deve reconectar?', shouldReconnect);
                
                if (shouldReconnect) {
                    console.log('Tentando reconectar após 5 segundos...');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    connectToWhatsApp();
                } else {
                    console.log('Conexão encerrada permanentemente.');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                console.log('Bot conectado com sucesso!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            // Verifica se a mensagem é nova (type === 'notify')
            if (type !== 'notify') return;
            
            console.log('Mensagem recebida:', JSON.stringify(messages, null, 2));
            const msg = messages[0];
            
            // Ignorar mensagens do tipo protocolMessage (ex: EPHEMERAL_SYNC_RESPONSE)
            if (msg.message.protocolMessage) {
                console.log('Mensagem protocolMessage ignorada.');
                return;
            }
            
            // Verifica se a mensagem existe e não é do próprio bot (fromMe === false)
            if (!msg.message || msg.key.fromMe) {
                console.log('Mensagem ignorada: vazia ou enviada pelo próprio bot');
                return;
            }
            
            console.log('Tipo de mensagem:', Object.keys(msg.message));
            console.log('De:', msg.key.remoteJid, 'Nome:', msg.pushName);
            
            // ====== AUTENTICAÇÃO E LIMITE DE USO ======
            let jidJson = (msg.key.participant || msg.key.remoteJid).replace(/(@g\.us|@s\.whatsapp\.net)$/i, '');
            let jidEnvio = msg.key.remoteJid;
            let usuarios = carregarUsuarios();
            
            // Se o número existir com @s.whatsapp.net, usar esse registro
            const fullJid = jidJson + '@s.whatsapp.net';
            if (usuarios[fullJid]) {
                jidJson = fullJid;
            }
            
            // Sempre garantir que o usuário seja registrado, mesmo se não existir no JSON
            if (!usuarios[jidJson]) {
                usuarios[jidJson] = {
                    nome: msg.pushName || null,
                    autenticado: false,
                    codigo: null,
                    usosHoje: 0,
                    ultimoUso: null,
                    optouAutenticacao: null
                };
                salvarUsuarios(usuarios);
            }
            let usuario = usuarios[jidJson];

            const hoje = new Date().toISOString().slice(0, 10);
            if (usuario.ultimoUso !== hoje) {
                usuario.usosHoje = 0;
                usuario.ultimoUso = hoje;
            }

            // Verificar primeiro se é comando de autenticação
            const texto = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption ||
                         msg.message.videoMessage?.caption;

            if (texto && texto.startsWith('!auth')) {
                const partes = texto.trim().split(' ');
                let codigoInformado = partes[1];

                if (usuario.autenticado) {
                    await sock.sendMessage(jidEnvio, { text: 'Você já está autenticado! Para cancelar e voltar ao limite de 5 usos por dia, envie !auth cancelar.' }, { quoted: msg });
                    await reagirMensagem(sock, msg, '✅');
                    return;
                }

                if (!codigoInformado) {
                    usuario.codigo = gerarCodigo();
                    usuario.optouAutenticacao = 'aguardando_codigo';
                    await sock.sendMessage(jidEnvio, { text: `Seu código de autenticação é: *${usuario.codigo}*\nResponda com !auth <número> para liberar acesso ilimitado!` }, { quoted: msg });
                    usuarios[jidJson] = usuario;
                    salvarUsuarios(usuarios);
                    await reagirMensagem(sock, msg, '✅');
                    return;
                }

                if (codigoInformado.toLowerCase() === 'cancelar') {
                    usuario.autenticado = false;
                    usuario.optouAutenticacao = 'cancelou';
                    usuario.codigo = null;
                    await sock.sendMessage(jidEnvio, { text: 'Autenticação cancelada! Agora você tem limite de 5 usos por dia.' }, { quoted: msg });
                    usuarios[jidJson] = usuario;
                    salvarUsuarios(usuarios);
                    await reagirMensagem(sock, msg, '✅');
                    return;
                }

                if (codigoInformado === usuario.codigo) {
                    usuario.autenticado = true;
                    usuario.optouAutenticacao = 'autenticado';
                    usuario.codigo = null;
                    await sock.sendMessage(jidEnvio, { text: 'Autenticação realizada com sucesso! Agora você tem acesso ilimitado.' }, { quoted: msg });
                    usuarios[jidJson] = usuario;
                    salvarUsuarios(usuarios);
                    await reagirMensagem(sock, msg, '✅');
                    return;
                } else {
                    await sock.sendMessage(jidEnvio, { text: 'Código incorreto! Se perdeu o número, envie !authperdi para gerar outro.' }, { quoted: msg });
                    await reagirMensagem(sock, msg, '❌');
                    return;
                }
            }

            if (texto && texto === '!authperdi') {
                usuario.codigo = gerarCodigo();
                usuario.autenticado = false;
                usuario.optouAutenticacao = 'aguardando_codigo';
                await sock.sendMessage(jidEnvio, { text: `Novo código de autenticação: *${usuario.codigo}*\nResponda com !auth <número> para liberar acesso ilimitado!` }, { quoted: msg });
                usuarios[jidJson] = usuario;
                salvarUsuarios(usuarios);
                await reagirMensagem(sock, msg, '✅');
                return;
            }

            // Limite de uso para não autenticados
            if (!usuario.autenticado) {
                if (usuario.usosHoje >= 5) {
                    await sock.sendMessage(jidEnvio, { text: 'Você atingiu o limite de 5 usos diários. Cadastre-se para uso ilimitado!' }, { quoted: msg });
                    await reagirMensagem(sock, msg, '❌');
                    return;
                }
                usuario.usosHoje += 1;
                usuarios[jidJson] = usuario;
                salvarUsuarios(usuarios);
            }
            // ====== FIM AUTENTICAÇÃO E LIMITE DE USO ======

            if (texto) {
                console.log('Texto recebido:', texto);
                
                try {
                    // Determinando o comando
                    let comando = '';
                    let conteudo = '';
                    
                    if (texto.startsWith('!')) {
                        const partes = texto.split(' ');
                        comando = partes[0];
                        conteudo = texto.replace(comando, '').trim();
                        
                        console.log('Comando detectado:', comando, 'Conteúdo:', conteudo);
                        
                        if (comando === '!fig') {
                            console.log('Processando comando !fig');
                            await criarFigurinhaImagem(sock, msg);
                        } else if (comando === '!gif') {
                            console.log('Processando comando !gif');
                            await criarFigurinhaGif(sock, msg);
                        } else if (comando === '!qrcode') {
                            console.log('Processando comando !qrcode com conteúdo:', conteudo);
                            if (conteudo.length === 0) {
                                await sock.sendMessage(msg.key.remoteJid, { text: 'Envie o texto ou link após !qrcode.' }, { quoted: msg });
                                await reagirMensagem(sock, msg, '❌');
                            } else {
                                await gerarQRCode(sock, msg, conteudo);
                            }
                        } else if (comando === '!figtxt') {
                            console.log('Processando comando !figtxt com conteúdo:', conteudo);
                            await figComTexto(sock, msg, conteudo);
                        } else if (comando === '!emoji') {
                            console.log('Processando comando !emoji com conteúdo:', conteudo);
                            await combinarEmojis(sock, msg, conteudo);
                        } else if (comando === '!songtxt') {
                            // Verifica se a mensagem é uma resposta a áudio
                            let audioMsg = msg.message.audioMessage ||
                                msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
                            let quotedMsg = msg;
                            if (!msg.message.audioMessage && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage) {
                                quotedMsg = {
                                    ...msg,
                                    message: msg.message.extendedTextMessage.contextInfo.quotedMessage
                                };
                            }
                            if (!audioMsg) {
                                await sock.sendMessage(msg.key.remoteJid, { text: 'Responda a um áudio com o comando !songtxt.' }, { quoted: msg });
                                await reagirMensagem(sock, msg, '❌');
                                return;
                            }
                            try {
                                const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {}, { reuploadRequest: sock });
                                let msgStatus = await sock.sendMessage(msg.key.remoteJid, { 
                                    text: '🔍 Analisando áudio...' 
                                }, { quoted: msg });

                                try {
                                    const updateStatus = async (texto) => {
                                        await sock.sendMessage(msg.key.remoteJid, { 
                                            text: texto,
                                            edit: msgStatus.key
                                        });
                                    };

                                    // Define evento para atualizar status
                                    const events = {
                                        onStart: () => updateStatus('⚙️ Iniciando processamento...'),
                                        onConvert: () => updateStatus('🔄 Convertendo formato do áudio...'),
                                        onUpload: () => updateStatus('📤 Enviando áudio para processamento...'),
                                        onProcess: () => updateStatus('🎯 Transcrevendo áudio... (pode demorar alguns minutos)'),
                                        onComplete: () => updateStatus('✨ Finalizando transcrição...')
                                    };

                                    const textoTranscrito = await transcreverAudio(buffer, events);
                                    
                                    if (textoTranscrito && textoTranscrito.length > 0) {
                                        await sock.sendMessage(msg.key.remoteJid, { 
                                            text: `✅ *Transcrição concluída:*\n\n${textoTranscrito}`,
                                            edit: msgStatus.key
                                        });
                                        await reagirMensagem(sock, msg, '✅');
                                    } else {
                                        throw new Error('Transcrição vazia');
                                    }
                                } catch (error) {
                                    console.error('Erro na transcrição:', error);
                                    await sock.sendMessage(msg.key.remoteJid, { 
                                        text: `❌ ${error.message || 'Erro ao transcrever o áudio. Tente novamente.'}`,
                                        edit: msgStatus.key
                                    });
                                    await reagirMensagem(sock, msg, '❌');
                                }
                            } catch (error) {
                                console.error('Erro na transcrição:', error);
                                await sock.sendMessage(msg.key.remoteJid, { 
                                    text: `❌ ${error.message || 'Erro ao transcrever o áudio. Tente novamente.'}` 
                                }, { quoted: msg });
                                await reagirMensagem(sock, msg, '❌');
                            }
                        } else if (comando === '!help') {
                            const menuText = `*🤖 AdeBot - Menu de Comandos*

*Figurinhas:*
🖼️ !fig - Criar figurinha de imagem
🎬 !gif - Criar figurinha de GIF
📝 !figtxt - Adicionar texto em figurinha
😃 !emoji - Combinar dois emojis

*Mídia:*
🎥 !ttkvideo - Baixar vídeo do TikTok
🎵 !ttkaudio - Baixar áudio do TikTok
🎵 !songtxt - Transcrever áudio para texto

*Utilitários:*
🔗 !qrcode - Gerar QR Code
🔑 !auth - Autenticação para uso ilimitado

*Dicas:*
- Use os comandos respondendo à mídia quando necessário
- Limite de 5 usos por dia (use !auth para liberar)
- Para ajuda com um comando específico, use-o sem conteúdo

*AdeBot - O bot de figurinhas e utilidades no WhatsApp!*`;

                            await sock.sendMessage(msg.key.remoteJid, { text: menuText }, { quoted: msg });
                            await reagirMensagem(sock, msg, '✅');
                        } else if (comando === '!ttkvideo' || comando === '!ttkaudio') {
                            if (!conteudo) {
                                await sock.sendMessage(msg.key.remoteJid, { text: 'Por favor, envie o link do vídeo do TikTok após o comando.' }, { quoted: msg });
                                await reagirMensagem(sock, msg, '❌');
                                return;
                            }

                            try {
                                await sock.sendMessage(msg.key.remoteJid, { text: 'Processando seu pedido, aguarde...' }, { quoted: msg });
                                
                                const tipo = comando === '!ttkvideo' ? 'video' : 'audio';
                                const resultado = await processarTikTok(conteudo, tipo);
                                
                                if (resultado && resultado.filePath) {
                                    const buffer = await fs.readFile(resultado.filePath);
                                    if (tipo === 'video') {
                                        await sock.sendMessage(msg.key.remoteJid, {
                                            video: buffer,
                                            caption: 'Aqui está seu vídeo do TikTok!'
                                        }, { quoted: msg });
                                    } else {
                                        console.log('Enviando áudio para o WhatsApp:', resultado.filePath);
                                        await sock.sendMessage(msg.key.remoteJid, {
                                            audio: buffer,
                                            mimetype: 'audio/mpeg' // Corrigido para audio/mpeg
                                        }, { quoted: msg });
                                        console.log('Áudio enviado com sucesso!');
                                    }
                                    await reagirMensagem(sock, msg, '✅');
                                    await fs.remove(resultado.filePath);
                                } else {
                                    throw new Error('Arquivo não encontrado');
                                }
                            } catch (error) {
                                console.error('Erro ao processar vídeo do TikTok:', error);
                                await sock.sendMessage(msg.key.remoteJid, { 
                                    text: 'Não foi possível processar este vídeo. Verifique se o link está correto e tente novamente.' 
                                }, { quoted: msg });
                                await reagirMensagem(sock, msg, '❌');
                            }
                        }
                    }
                } catch (error) {
                    console.error('Erro ao processar comando:', error);
                    await sock.sendMessage(msg.key.remoteJid, { text: 'Ocorreu um erro ao processar seu comando. Tente novamente.' }, { quoted: msg });
                    await reagirMensagem(sock, msg, '❌');
                }
            } else {
                console.log('Mensagem sem texto recebida, verificando se precisa processar');
                
                // Verifica se a mensagem contém mídia mesmo sem texto/legenda
                if (msg.message.imageMessage) {
                    console.log('Imagem recebida sem legenda');
                } else if (msg.message.videoMessage?.gifPlayback) {
                    console.log('GIF recebido sem legenda');
                } else if (msg.message.stickerMessage) {
                    console.log('Figurinha recebida sem comando');
                }
            }
        });
    } catch (error) {
        console.error('Erro ao inicializar o bot:', error);
        throw error;
    }
}

// Função auxiliar para verificar JIDs de broadcast
function isJidBroadcast(jid) {
    return jid.includes('@broadcast');
}

// Inicia o bot com tratamento de erros
connectToWhatsApp().catch(err => {
    console.error('Erro fatal ao iniciar o bot:', err);
    process.exit(1);
});

// Tratamento de erros não capturados
process.on('uncaughtException', err => {
    console.error('Erro não capturado:', err);
});

process.on('unhandledRejection', err => {
    console.error('Promise rejeitada não tratada:', err);
});

// Limpa arquivos temporários a cada hora
setInterval(async () => {
    try {
        await limparArquivosTemporários();
    } catch (error) {
        console.error('Erro ao limpar arquivos temporários:', error);
    }
}, 3600000); // 1 hora em milissegundos
