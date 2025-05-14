import sys
import os
import json
import requests
import time
from urllib.parse import urlparse, parse_qs
from moviepy.editor import VideoFileClip

def extrair_video_id(url):
    """Extrai o ID do vídeo de uma URL do TikTok"""
    # Padrões de URL do TikTok
    if 'vm.tiktok.com' in url or 'vt.tiktok.com' in url:
        # Para links encurtados, precisamos primeiro seguir o redirecionamento
        try:
            response = requests.head(url, allow_redirects=True)
            url = response.url
        except Exception as e:
            print(json.dumps({'error': f'Erro ao seguir redirecionamento: {str(e)}'}), file=sys.stderr)
            return None
    
    try:
        # Tenta extrair diretamente do padrão /video/{id}/
        import re
        video_id_match = re.search(r'/video/(\d+)', url)
        if video_id_match:
            return video_id_match.group(1)
        
        # Se não encontrou, tenta outros padrões
        parsed_url = urlparse(url)
        
        # Para URL completa do TikTok
        if 'tiktok.com' in parsed_url.netloc:
            path_parts = parsed_url.path.split('/')
            for i, part in enumerate(path_parts):
                if part == 'video' and i+1 < len(path_parts):
                    return path_parts[i+1]
        
        # Último recurso: tentar extrair da query string
        query_params = parse_qs(parsed_url.query)
        if 'item_id' in query_params:
            return query_params['item_id'][0]
        
        print(json.dumps({'error': 'ID do vídeo não encontrado na URL'}), file=sys.stderr)
        return None
    except Exception as e:
        print(json.dumps({'error': f'Erro ao extrair ID do vídeo: {str(e)}'}), file=sys.stderr)
        return None

def baixar_tiktok(url, tipo='video'):
    """Baixa vídeo ou áudio do TikTok usando a API RapidAPI"""
    try:
        print(f"Iniciando download de {tipo} da URL: {url}", file=sys.stderr)

        # Extrai o ID do vídeo da URL
        video_id = extrair_video_id(url)
        if not video_id:
            print(json.dumps({'error': 'Não foi possível extrair o ID do vídeo'}), file=sys.stderr)
            return None
        
        print(f"ID do vídeo: {video_id}", file=sys.stderr)
        
        # Configura a API do TikTok da RapidAPI
        api_url = "https://tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com/index"
        querystring = {"url": url}
        
        headers = {
            "x-rapidapi-key": "cbfabb0ce9msh6dac7393bc32b60p1d0f32jsne16e54122b3e",
            "x-rapidapi-host": "tiktok-downloader-download-tiktok-videos-without-watermark.p.rapidapi.com"
        }
        
        print("Fazendo requisição para a API correta...", file=sys.stderr)
        
        # Faz a requisição para a API
        response = requests.get(api_url, headers=headers, params=querystring)
        
        if response.status_code != 200:
            print(json.dumps({'error': f'Erro na requisição: Status {response.status_code}'}), file=sys.stderr)
            return None
        
        try:    
            data = response.json()
            print(f"Resposta da API recebida, processando dados...", file=sys.stderr)
            
            video_url = None
            audio_url = None
            
            # Extrai o link do vídeo sem marca d'água
            if 'video' in data and isinstance(data['video'], list) and len(data['video']) > 0:
                video_url = data['video'][0]
                print(f"URL encontrada no campo 'video': {video_url}", file=sys.stderr)
            
            # Extrai o link do áudio se solicitado
            if tipo == 'audio' and 'music' in data and isinstance(data['music'], list) and len(data['music']) > 0:
                audio_url = data['music'][0]
                print(f"URL encontrada no campo 'music': {audio_url}", file=sys.stderr)
            
            # Se não encontrou, retorna erro
            if tipo == 'audio' and not audio_url:
                print(json.dumps({'error': 'URL do áudio não encontrada na resposta da API'}), file=sys.stderr)
                return None
            
            if tipo == 'video' and not video_url:
                print(json.dumps({'error': 'URL do vídeo não encontrada na resposta da API'}), file=sys.stderr)
                return None
            
            # Cria pasta de downloads se não existir
            pasta = os.path.join(os.getcwd(), 'downloads')
            os.makedirs(pasta, exist_ok=True)
            
            # Define o nome do arquivo baseado no timestamp atual
            timestamp = int(time.time())
            
            if tipo == 'audio':
                audio_path = os.path.join(pasta, f'tiktok_{timestamp}.mp3')
                print(f"Baixando áudio de: {audio_url}", file=sys.stderr)
                audio_response = requests.get(audio_url)
                if audio_response.status_code != 200:
                    print(json.dumps({'error': f'Erro ao baixar áudio: Status {audio_response.status_code}'}), file=sys.stderr)
                    return None
                
                with open(audio_path, 'wb') as f:
                    f.write(audio_response.content)
                
                print(f"Áudio salvo em: {audio_path}", file=sys.stderr)
                
                resultado = {'filePath': audio_path, 'type': 'audio'}
                print(json.dumps(resultado))
                return resultado
            
            else:
                video_path = os.path.join(pasta, f'tiktok_{timestamp}.mp4')
                print(f"Baixando vídeo de: {video_url}", file=sys.stderr)
                video_response = requests.get(video_url)
                if video_response.status_code != 200:
                    print(json.dumps({'error': f'Erro ao baixar vídeo: Status {video_response.status_code}'}), file=sys.stderr)
                    return None
                
                with open(video_path, 'wb') as f:
                    f.write(video_response.content)
                
                print(f"Vídeo salvo em: {video_path}", file=sys.stderr)
                
                resultado = {'filePath': video_path, 'type': 'video'}
                print(json.dumps(resultado))
                return resultado
            
        except Exception as e:
            print(f"Erro ao processar resposta JSON: {str(e)}", file=sys.stderr)
            print(f"Resposta bruta: {response.text[:500]}", file=sys.stderr)  # Mostra os primeiros 500 caracteres da resposta
            return None
            
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        return None

def main():
    """Função principal que processa os argumentos da linha de comando"""
    # Se não tiver argumentos suficientes
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Argumentos insuficientes. Use uma URL"}))
        sys.exit(1)
    
    # Se o primeiro argumento parece ser uma URL, é um download
    primeiro_arg = sys.argv[1]
    if primeiro_arg.startswith('http'):
        tipo = sys.argv[2] if len(sys.argv) > 2 else 'video'
        resultado = baixar_tiktok(primeiro_arg, tipo)
        if resultado:
            sys.exit(0)
        else:
            sys.exit(1)
    else:
        print(json.dumps({"error": "URL inválida"}))
        sys.exit(1)

if __name__ == "__main__":
    main()