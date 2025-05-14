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

/**
 * Faz upload do arquivo para o Google Cloud Storage
 * @param {string} filePath - Caminho do arquivo local
 * @returns {Promise<string>} - URI do arquivo no GCS
 */
async function uploadToGCS(filePath) {
    const fileName = `audio_${Date.now()}.ogg`;
    
    try {
        // Upload direto para o bucket existente
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
 * Transcreve um arquivo de áudio usando o Google Cloud Speech-to-Text
 * @param {Buffer} audioBuffer - Buffer contendo o áudio a ser transcrito
 * @param {Object} events - Objeto com funções de callback para eventos
 * @returns {Promise<string>} - Texto transcrito
 */
async function transcreverAudio(audioBuffer, events = {}) {
    const tempInputFile = './temp_input.opus';
    const tempOutputFile = './temp_audio.ogg';
    let gcsUri = null;
    
    try {
        console.log('Iniciando transcrição com Google Speech-to-Text...');
        
        if (events.onStart) await events.onStart();
        
        // Salva o buffer em arquivo temporário
        await fs.writeFile(tempInputFile, audioBuffer);
        
        if (events.onConvert) await events.onConvert();
        
        // Converte o áudio para o formato correto
        await new Promise((resolve, reject) => {
            ffmpeg(tempInputFile)
                .toFormat('opus')
                .audioCodec('libopus')
                .audioChannels(1)
                .audioFrequency(48000)
                .on('end', resolve)
                .on('error', reject)
                .save(tempOutputFile);
        });
        
        // Verifica o tamanho do arquivo
        const stats = await fs.stat(tempOutputFile);
        const fileSizeInMB = stats.size / (1024 * 1024);
        console.log(`Tamanho do arquivo: ${fileSizeInMB.toFixed(2)}MB`);

        // Configuração base para o reconhecimento
        const config = {
            encoding: 'WEBM_OPUS',
            sampleRateHertz: 48000,
            audioChannelCount: 1,
            enableAutomaticPunctuation: true,
            languageCode: 'pt-BR',
            model: 'latest_long',
            useEnhanced: true
        };

        let transcricao;
        
        // Para áudios longos, usa o GCS e longRunningRecognize
        if (fileSizeInMB > 0.5) {
            console.log('Áudio longo detectado, usando upload para GCS...');
            
            if (events.onUpload) await events.onUpload();
            
            // Faz upload do arquivo para o GCS
            gcsUri = await uploadToGCS(tempOutputFile);
            console.log('Arquivo enviado para GCS:', gcsUri);
            
            if (events.onProcess) await events.onProcess();
            
            // Configura a requisição com o URI do GCS
            const request = {
                audio: { uri: gcsUri },
                config: config
            };

            // Inicia a operação de longa duração
            const [operation] = await client.longRunningRecognize(request);
            console.log('Aguardando conclusão da transcrição...');
            const [response] = await operation.promise();
            
            transcricao = response.results
                .map(result => result.alternatives[0].transcript)
                .join('\n');
        } else {
            // Para áudios curtos, usa reconhecimento síncrono
            console.log('Áudio curto detectado, usando reconhecimento síncrono...');
            const audioBytes = await fs.readFile(tempOutputFile);
            const request = {
                audio: { content: audioBytes.toString('base64') },
                config: config
            };
            
            const [response] = await client.recognize(request);
            transcricao = response.results
                .map(result => result.alternatives[0].transcript)
                .join('\n');
        }

        if (events.onComplete) await events.onComplete();

        // Limpa os arquivos
        await fs.remove(tempInputFile);
        await fs.remove(tempOutputFile);
        if (gcsUri) {
            await deleteFromGCS(gcsUri);
        }
        
        console.log('Transcrição concluída com sucesso');
        return transcricao;
        
    } catch (error) {
        console.error('Erro ao transcrever áudio:', error);
        
        // Limpa os arquivos em caso de erro
        try {
            await fs.remove(tempInputFile);
            await fs.remove(tempOutputFile);
            if (gcsUri) {
                await deleteFromGCS(gcsUri);
            }
        } catch (cleanupError) {
            console.error('Erro ao limpar arquivos:', cleanupError);
        }
        
        // Retorna mensagens de erro mais amigáveis
        if (error.code === 7) {
            throw new Error('O áudio é muito longo. Por favor, envie um áudio mais curto.');
        } else if (error.code === 3 && error.details?.includes('audio exceeds')) {
            throw new Error('Processando áudio longo, aguarde um momento...');
        } else if (error.code === 'ENOENT') {
            throw new Error('Erro ao processar o arquivo de áudio. Tente novamente.');
        } else {
            throw new Error('Ocorreu um erro ao transcrever o áudio. Por favor, tente novamente.');
        }
    }
}

module.exports = {
    transcreverAudio
};
