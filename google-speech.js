require('dotenv').config();
const speech = require('@google-cloud/speech');
const {Storage} = require('@google-cloud/storage');
const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Configuração do caminho das credenciais
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(__dirname, 'google-credentials.json');

// Inicializa os clientes do Google Cloud
const client = new speech.SpeechClient();
const storage = new Storage();
const bucketName = 'adeilton-bot-audio';

// Sistema de fila e controle de concorrência
const transcriptionQueue = [];
const maxConcurrentTranscriptions = 3; // Número máximo de transcrições simultâneas
let activeTranscriptions = 0;

/**
 * Faz upload do arquivo para o Google Cloud Storage
 * @param {string} filePath - Caminho do arquivo local 
 * @returns {Promise<string>} - URI do arquivo no GCS
 */
async function uploadToGCS(filePath) {
    const fileName = `audio_${Date.now()}_${Math.random().toString(36).substring(7)}.ogg`;
    
    try {
        await storage.bucket(bucketName).upload(filePath, {
            destination: fileName,
            metadata: {
                contentType: 'audio/ogg'
            }
        });

        return `gs://${bucketName}/${fileName}`;
    } catch (error) {
        console.error('Erro no upload para GCS:', error);
        throw error;
    }
}

/**
 * Remove um arquivo do Google Cloud Storage
 * @param {string} gcsUri - URI do arquivo no GCS
 */
async function deleteFromGCS(gcsUri) {
    try {
        const fileName = gcsUri.split('/').pop();
        await storage.bucket(bucketName).file(fileName).delete();
    } catch (error) {
        console.error('Erro ao deletar arquivo do GCS:', error);
    }
}

/**
 * Processa um item da fila de transcrição
 */
async function processNextInQueue() {
    if (transcriptionQueue.length === 0 || activeTranscriptions >= maxConcurrentTranscriptions) {
        return;
    }

    activeTranscriptions++;
    const task = transcriptionQueue.shift();

    try {
        const result = await processTranscription(task.audioBuffer, task.events);
        task.resolve(result);
    } catch (error) {
        task.reject(error);
    } finally {
        activeTranscriptions--;
        // Processa o próximo item da fila se houver
        process.nextTick(processNextInQueue);
    }
}

/**
 * Processa a transcrição de um áudio
 * @param {Buffer} audioBuffer - Buffer do áudio
 * @param {Object} events - Eventos de callback
 * @returns {Promise<string>} - Texto transcrito
 */
async function processTranscription(audioBuffer, events = {}) {
    const tempDir = path.join(__dirname, 'temp');
    const tempInputFile = path.join(tempDir, `input_${Date.now()}_${Math.random().toString(36).substring(7)}.opus`);
    const tempOutputFile = path.join(tempDir, `output_${Date.now()}_${Math.random().toString(36).substring(7)}.ogg`);
    
    await fs.ensureDir(tempDir);
    let gcsUri = null;
    
    try {
        console.log('Iniciando transcrição com Google Speech-to-Text...');
        
        if (events.onStart) await events.onStart();
        
        await fs.writeFile(tempInputFile, audioBuffer);
        
        if (events.onConvert) await events.onConvert();
        
        await new Promise((resolve, reject) => {
            ffmpeg(tempInputFile)
                .toFormat('ogg')
                .audioCodec('libopus')
                .audioChannels(1)
                .audioFrequency(48000)
                .outputOptions([
                    '-c:a libopus',
                    '-b:a 128k',
                    '-application voip'
                ])
                .on('end', resolve)
                .on('error', reject)
                .save(tempOutputFile);
        });
        
        const stats = await fs.stat(tempOutputFile);
        const fileSizeInMB = stats.size / (1024 * 1024);
        console.log(`Tamanho do arquivo: ${fileSizeInMB.toFixed(2)}MB`);

        const config = {
            encoding: 'OGG_OPUS',
            sampleRateHertz: 48000,
            audioChannelCount: 1,
            enableAutomaticPunctuation: true,
            languageCode: 'pt-BR',
            model: 'latest_long',
            useEnhanced: true,
            enableWordTimeOffsets: true,
            profanityFilter: false,
            enableWordConfidence: true
        };

        let transcricao;
        
        if (fileSizeInMB > 0.5) {
            console.log('Áudio longo detectado, usando upload para GCS...');
            
            if (events.onUpload) await events.onUpload();
            
            try {
                let retries = 3;
                while (retries > 0) {
                    try {
                        gcsUri = await uploadToGCS(tempOutputFile);
                        console.log('Arquivo enviado para GCS:', gcsUri);
                        break;
                    } catch (error) {
                        retries--;
                        if (retries === 0) throw error;
                        console.log(`Tentando upload novamente. Tentativas restantes: ${retries}`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
                
                if (events.onProcess) await events.onProcess();
                
                const request = {
                    audio: { uri: gcsUri },
                    config: config
                };

                const [operation] = await client.longRunningRecognize(request);
                console.log('Aguardando conclusão da transcrição...');
                
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Timeout na transcrição')), 300000);
                });
                
                const [response] = await Promise.race([
                    operation.promise(),
                    timeoutPromise
                ]);
                
                if (!response?.results?.length) {
                    throw new Error('Nenhum resultado encontrado na transcrição');
                }
                
                transcricao = response.results
                    .filter(result => result?.alternatives?.[0]?.transcript)
                    .map(result => result.alternatives[0].transcript)
                    .join('\n');
                    
                if (!transcricao) {
                    throw new Error('Transcrição retornou vazia');
                }
                
            } catch (error) {
                console.error('Erro específico na transcrição:', error);
                throw error;
            }
        } else {
            console.log('Áudio curto detectado, usando reconhecimento síncrono...');
            const audioBytes = await fs.readFile(tempOutputFile);
            const request = {
                audio: { content: audioBytes.toString('base64') },
                config: config
            };
            
            const [response] = await client.recognize(request);
            
            if (!response?.results?.length) {
                throw new Error('Nenhum resultado encontrado na transcrição');
            }
            
            transcricao = response.results
                .filter(result => result?.alternatives?.[0]?.transcript)
                .map(result => result.alternatives[0].transcript)
                .join('\n');
                
            if (!transcricao) {
                throw new Error('Transcrição retornou vazia');
            }
        }

        if (events.onComplete) await events.onComplete();

        await fs.remove(tempInputFile);
        await fs.remove(tempOutputFile);
        if (gcsUri) {
            await deleteFromGCS(gcsUri);
        }
        
        console.log('Transcrição concluída com sucesso');
        return transcricao;
        
    } catch (error) {
        console.error('Erro ao transcrever áudio:', error);
        
        try {
            await fs.remove(tempInputFile);
            await fs.remove(tempOutputFile);
            if (gcsUri) {
                await deleteFromGCS(gcsUri);
            }
        } catch (cleanupError) {
            console.error('Erro ao limpar arquivos:', cleanupError);
        }
        
        if (error.message === 'Timeout na transcrição') {
            throw new Error('A transcrição está demorando muito. Por favor, tente novamente com um áudio menor.');
        } else if (error.message === 'Nenhum resultado encontrado na transcrição' || error.message === 'Transcrição retornou vazia') {
            throw new Error('Não foi possível reconhecer o áudio. Verifique se o áudio está claro e tente novamente.');
        } else if (error.code === 7) {
            throw new Error('O áudio é muito longo. Por favor, envie um áudio mais curto.');
        } else if (error.code === 3 && error.details?.includes('audio exceeds')) {
            throw new Error('Processando áudio longo, aguarde um momento...');
        } else if (error.code === 'ENOENT') {
            throw new Error('Erro ao processar o arquivo de áudio. Tente novamente.');
        } else {
            console.error('Erro detalhado:', error);
            throw new Error('Ocorreu um erro ao transcrever o áudio. Por favor, tente novamente.');
        }
    }
}

/**
 * Função principal que gerencia a fila de transcrição
 * @param {Buffer} audioBuffer - Buffer do áudio a ser transcrito
 * @param {Object} events - Eventos de callback
 * @returns {Promise<string>} - Texto transcrito
 */
async function transcreverAudio(audioBuffer, events = {}) {
    return new Promise((resolve, reject) => {
        transcriptionQueue.push({
            audioBuffer,
            events,
            resolve,
            reject
        });
        
        // Inicia o processamento se possível
        processNextInQueue();
    });
}

module.exports = {
    transcreverAudio
};
