from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import threading
import time
import json
import os
import webbrowser
import asyncio
import edge_tts
import base64
import sounddevice as sd
import numpy as np
from scipy.io import wavfile
import tempfile
import requests
import sqlite3
import winsound
import subprocess
import contextlib
import io
from datetime import datetime
from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage, SystemMessage

try:
    from langchain_community.tools import DuckDuckGoSearchRun
    search_tool = DuckDuckGoSearchRun()
except:
    search_tool = None

try:
    import pyautogui
except:
    pyautogui = None

CONFIG_FILE = "config.json"
AGENDA_DB = "mega_agenda.db"

def init_db():
    conn = sqlite3.connect(AGENDA_DB)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS lembretes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            texto TEXT NOT NULL,
            data_hora TEXT NOT NULL,
            status TEXT DEFAULT 'pendente'
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS atalhos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL UNIQUE,
            url TEXT NOT NULL
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS memoria_longo_prazo (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            informacao TEXT NOT NULL
        )
    """)
    # Links iniciais passados pelo Wallison
    atalhos_iniciais = [
        ('suporte', 'https://meganet-suport-git-main-wallison-rangels-projects.vercel.app/'),
        ('atlaz', 'https://meganett.atlaz.com.br/admin'),
        ('rede mega', 'https://meganett.atlaz.com.br/admin'),
        ('flash monitor', 'https://flashmonitor.com.br') # Exemplo se tiver
    ]
    for n, u in atalhos_iniciais:
        cursor.execute("INSERT OR IGNORE INTO atalhos (nome, url) VALUES (?, ?)", (n, u))
    conn.commit()
    conn.close()

init_db()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

event_queue = asyncio.Queue()

class ConfigModel(BaseModel):
    modelType: str
    apiKey: str
    systemEmail: str
    systemPassword: str
    sensitivity: float = 0.002

class ChatMessage(BaseModel):
    message: str

current_config = {
    "modelType": "groq", 
    "apiKey": "", 
    "systemEmail": "", 
    "systemPassword": "",
    "sensitivity": 0.002
}

async def gerar_audio_base64(texto):
    try:
        communicate = edge_tts.Communicate(texto, "pt-BR-AntonioNeural", rate="+0%", pitch="-5Hz")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as tmp:
            tmp_path = tmp.name
        await communicate.save(tmp_path)
        with open(tmp_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode('utf-8')
        try: os.unlink(tmp_path)
        except: pass
        return b64
    except Exception as e:
        print(f"[TTS ERR] {e}")
        return None

# --- FERRAMENTAS ---
def skill_pesquisar_web(query):
    if not search_tool: return "Módulo de pesquisa indisponível."
    try: return search_tool.run(query)
    except Exception as e: return f"Erro na pesquisa: {e}"

def skill_agenda_lembrete(texto, data_hora=""):
    try:
        conn = sqlite3.connect(AGENDA_DB)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO lembretes (texto, data_hora) VALUES (?, ?)", (texto, data_hora))
        conn.commit(); conn.close()
        return f"Lembrete agendado: '{texto}'."
    except Exception as e: return f"Erro na agenda: {e}"

def skill_listar_agenda():
    try:
        conn = sqlite3.connect(AGENDA_DB)
        cursor = conn.cursor()
        cursor.execute("SELECT texto, data_hora FROM lembretes WHERE status = 'pendente' LIMIT 5")
        tasks = cursor.fetchall(); conn.close()
        if not tasks: return "Sua agenda está vazia."
        res = "Seus lembretes:\n"
        for t in tasks: res += f"- {t[0]} ({t[1]})\n"
        return res
    except: return "Erro ao acessar agenda."

def skill_controlar_midia(acao):
    if not pyautogui: return "Mídia indisponível."
    try:
        if "pause" in acao or "play" in acao: pyautogui.press("playpause")
        elif "proxima" in acao or "skip" in acao: pyautogui.press("nexttrack")
        elif "anterior" in acao: pyautogui.press("prevtrack")
        return "Comando enviado."
    except: return "Erro mídia."

def skill_adicionar_atalho(nome, url):
    try:
        conn = sqlite3.connect(AGENDA_DB)
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO atalhos (nome, url) VALUES (?, ?)", (nome.lower(), url))
        conn.commit(); conn.close()
        return f"Link de {nome} gravado na memória base."
    except Exception as e: return f"Falha ao gravar memória: {e}"

def skill_salvar_memoria(info):
    try:
        conn = sqlite3.connect(AGENDA_DB)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO memoria_longo_prazo (informacao) VALUES (?)", (info,))
        conn.commit(); conn.close()
        return f"Informação gravada na memória de longo prazo: {info}"
    except Exception as e: return f"Falha ao gravar memória: {e}"

def skill_abrir_atalho(nome, url_sugerido=""):
    try:
        # 1. Checa a memória principal do usuário
        conn = sqlite3.connect(AGENDA_DB)
        cursor = conn.cursor()
        cursor.execute("SELECT url FROM atalhos WHERE nome LIKE ?", (f"%{nome.lower()}%",))
        res = cursor.fetchone(); conn.close()
        
        if res:
            webbrowser.open(res[0])
            return f"Abrindo {nome} direto da nossa memória."
        elif url_sugerido and str(url_sugerido).startswith("http"):
            # 2. IA encontrou o link publicamente
            webbrowser.open(url_sugerido)
            return f"Não tinha na memória, mas ajustei os protocolos e estou abrindo o site do {nome}."
        else:
            # 3. Fallback inteligente (Google/Direct)
            termo = nome.lower().replace(" ", "")
            webbrowser.open(f"https://{termo}.com")
            return f"Tentando rota de acesso direto para {nome}."
    except Exception as e: return f"Erro ao acessar navegadores: {e}"

def skill_run_cmd(command):
    try:
        print(f"[SYSTEM EXEC] Terminal Rota Autorizada: {command[:200]}")
        resultado = subprocess.run(["powershell", "-Command", command], capture_output=True, text=True, timeout=40)
        out = resultado.stdout if resultado.stdout else resultado.stderr
        return out if out else "Comando powershell executado silenciosamente e com sucesso."
    except Exception as e:
        return f"Erro Crítico de Console: {e}"

def skill_python_exec(codigo):
    output = io.StringIO()
    try:
        print("[SYSTEM EXEC] Executando bloco Python interno.")
        with contextlib.redirect_stdout(output):
            exec(codigo, globals())
        val = output.getvalue()
        return val if val else "Script rodou com sucesso sem gerar prints na tela."
    except Exception as e:
        return f"Exceção no kernel Python: {e}"

class MegaAgent:
    def __init__(self, config):
        self.config = config
        self.llm = ChatGroq(api_key=config["apiKey"], model="llama-3.3-70b-versatile", temperature=0.2)
        self.history = []
    
    def get_memoria_links(self):
        try:
            conn = sqlite3.connect(AGENDA_DB)
            cursor = conn.cursor()
            cursor.execute("SELECT nome FROM atalhos")
            links = [row[0] for row in cursor.fetchall()]
            conn.close()
            return ", ".join(links)
        except: return "Nenhum"

    def get_memoria_longo_prazo(self):
        try:
            conn = sqlite3.connect(AGENDA_DB)
            cursor = conn.cursor()
            cursor.execute("SELECT informacao FROM memoria_longo_prazo")
            infos = [row[0] for row in cursor.fetchall()]
            conn.close()
            return " | ".join(infos)
        except: return "Nenhum"

    def process_command(self, command_text):
        if not hasattr(self, 'history'):
            self.history = []
            
        self.history.append(HumanMessage(content=command_text))
        
        # Limita histórico base para não estourar tokens
        if len(self.history) > 16:
            self.history = self.history[-16:]

        links_salvos = self.get_memoria_links()
        memorias_gerais = self.get_memoria_longo_prazo()
        
        # Variáveis Fixas de Sistema Real
        user_profile = os.environ.get("USERPROFILE", "C:\\Users")
        
        tentativas_de_loop = 0

        while True:
            tentativas_de_loop += 1
            if tentativas_de_loop > 6:
                return "Sr., demorei demais processando isso. Estou abortando para evitar falhas sistêmicas."
                
            prompt = f"""[SYSTEM] Você é o MEGA Executive, um Sistema Autônomo e IA de nível kernel do Wallison Rangel.
Você agora tem capacidade de OpenInterpreter: pode ler e executar comandos livremente no computador dele via Poweshell ou executar Python abstrato.
Caminho Oficial do Sistema do Usuário: {user_profile}  (ATENÇÃO: Este caminho contém espaços. SEMPRE use aspas no PowerShell, ex: mkdir "{user_profile}\\Desktop\\MegaA")
Links salvos: {links_salvos} | Fatos Importantes: {memorias_gerais}.

-> REGRAS DE AUTONOMIA E SEGURANÇA (LEIA COM ATENÇÃO): <-
Se você precisar CRIAR pastas, MODIFICAR arquivos, INSTALAR dependências ou EXCLUIR alguma coisa, VOCÊ DEVE OBRIGATORIAMENTE usar o skill "ask_permission" ANTES de executar o comando. Não rode o terminal antes da aprovação do Wallison.
Se ele te der o comando (ex: "pode fazer, crie a pasta"), no seu próximo turno você usará "run_cmd" e passará o comando no terminal.
Comandos de leitura (dir, ler arquivo com type, ping, consultar info base) ou execução de scripts Python não-destrutivos não precisam de permissão.

-> REGRAS DE AUTOMAÇÃO WEB (SELENIUM): <-
Se o usuário pedir para PREENCHER FORMULÁRIOS, LER CÓDIGO HTML ou NAVEGAR de forma complexa, use "run_python" e escreva um script com `selenium`.
1) Inicie o navegador e abra o site: `from selenium import webdriver; from selenium.webdriver.common.by import By; driver = webdriver.Chrome(); driver.get('URL')`
2) O interpretador persiste as variáveis na área local da memória (global). Ou seja, se você já criou o `driver` num turno anterior, NAS PRÓXIMAS EXECUÇÕES PODE APENAS USÁ-LO diretamente! **NUNCA CHAME webdriver.Chrome() COM O NAVEGADOR JÁ ABERTO!** Evite sobreposição. Se der erro NameError 'driver', inicie-o.
3) Para descobrir os campos ocultos: rode `print(driver.page_source)` para ler o HTML no retorno do Log, ou tente localizar imprimindo nomes/IDs.
4) Para interagir: rode um Python interagindo de fato: `driver.find_element(By.ID, 'x').send_keys('dado')` seguido de `driver.find_element(By.XPATH, 'xx').click()`.
5) NÃO faça `driver.quit()`, mantenha aberto pro usuário visualizar.

-> LISTA DE SKILLS E FORMATO JSON OBRIGATÓRIO: <-
- CHAT: {{ "skill": "none", "response": "sua resposta final falada de forma curta..." }} (Use para falar e encerrar turno)
- ASK_PERMISSION: {{ "skill": "ask_permission", "command_intent": "criar app", "response": "Sr, preciso abrir o powershell para iniciar o app. Autoriza?" }} (Encerra o turno aguardando resposta)
- TERMINAL_CMD: {{ "skill": "run_cmd", "command": "comando powershell/cmd válido no windows usando aspas em caminhos com espaco" }} (Fica no loop invisível e lê o resultado no log)
- PYTHON_RUN: {{ "skill": "run_python", "code": "print('hello')" }} (Fica no loop invisível)
- BROWSER_OPEN_LINK: {{ "skill": "open_link", "name": "...", "url": "https://..." }} (Encerra turno com Acesso Concedido)
- SEARCH: {{ "skill": "search", "query": "..." }}
- AGENDA_ADD: {{ "skill": "agenda_add", "text": "...", "time": "..." }}
- MEMORY_SAVE_FACT: {{ "skill": "save_fact", "fact": "..." }}
- MEMORY_SAVE_LINK: {{ "skill": "save_link", "name": "...", "url": "http..." }}
- MEDIA: {{ "skill": "media", "action": "pause|play|next|prev" }}

Horário Atual: {datetime.now().strftime('%H:%M:%S')}"""

            messages = [SystemMessage(content=prompt)] + self.history

            try:
                resp = self.llm.invoke(messages)
                self.history.append(resp) # Salva a própria saída para manter a coesão
                
                raw_text = resp.content.strip()
                # Tenta extrair qualquer coisa entre chaves se houver Markdown
                import re
                match = re.search(r'\{.*\}', raw_text, re.DOTALL)
                if match:
                    json_str = match.group(0)
                else:
                    json_str = raw_text

                try:
                    data = json.loads(json_str)
                except json.JSONDecodeError as je:
                    print(f"[JSON FIX LOOP] Erro na formatação. Forçando auto-correção...")
                    self.history.append(SystemMessage(content="ATENÇÃO: Sua última resposta NÃO foi um JSON válido. Por favor, corrija e responda EXATAMENTE e APENAS no formato { \"skill\": \"...\" } sem textos adicionais."))
                    continue
                    
                skill = data.get("skill")
                
                print(f"[REASONING] A IA optou pela skill: '{skill}'")

                # -> Interruções de Turno (Devolvem áudio e pausam) <-
                if skill == "none":
                    return data.get("response", "Finalizado.")
                elif skill == "ask_permission":
                    return data.get("response", "Me dê permissão para rodar a rotina de terminal, senhor.")
                elif skill == "open_link":
                    res = skill_abrir_atalho(data.get("name"), data.get("url", ""))
                    return f"Portas abertas. {res}"
                elif skill == "save_fact":
                    return skill_salvar_memoria(data.get("fact"))
                elif skill == "save_link":
                    return skill_adicionar_atalho(data.get("name"), data.get("url"))
                elif skill == "media":
                    return skill_controlar_midia(data.get("action"))
                elif skill == "agenda_add":
                    return skill_agenda_lembrete(data.get("text"), data.get("time"))
                
                # -> Loop Invisível Autônomo (Injeta a resposta do comando de volta na história) <-
                elif skill == "run_cmd":
                    cmd = data.get("command", "")
                    out = skill_run_cmd(cmd)
                    self.history.append(SystemMessage(content=f"> [Powershell Output de `{cmd}`]:\n{out[:1200]}"))
                    # Deixa rodar o While novamente para que o modelo LEIA o output e tome próxima decisão
                    continue

                elif skill == "run_python":
                    code = data.get("code", "")
                    out = skill_python_exec(code)
                    self.history.append(SystemMessage(content=f"> [Python Output]:\n{out[:2000]}"))
                    # Continua o loop
                    continue

                elif skill == "search":
                    query = data.get("query", "")
                    out = skill_pesquisar_web(query)
                    self.history.append(SystemMessage(content=f"> [DuckDuckGo Output]:\n{out[:1200]}"))
                    # Continua o loop
                    continue
                
                elif skill == "agenda_list":
                    out = skill_listar_agenda()
                    self.history.append(SystemMessage(content=f"> [Agenda Lida]:\n{out}"))
                    continue

                else:
                    return data.get("response", "Matriz instável. Comandos autônomos falharam.")

            except Exception as e:
                print(f"[ERRO DE ROTA COGNITIVA] {e}")
                return "Sr., ocorreu uma falha grave na interpretação de raciocínio. Loop abortado por segurança."

mega_agent_instance = None

@app.post("/api/config")
async def save_config(config: ConfigModel):
    global mega_agent_instance
    current_config.update(config.dict())
    mega_agent_instance = MegaAgent(current_config)
    with open(CONFIG_FILE, "w") as f: json.dump(current_config, f)
    msg = "Sincronizado."
    audio = await gerar_audio_base64(msg)
    return {"status": "success", "response": msg, "audio": audio}

@app.get("/api/config")
def get_config(): return current_config

@app.get("/api/calibrate")
async def calibrate():
    fs = 16000
    try:
        rec = sd.rec(int(2.0 * fs), samplerate=fs, channels=1); sd.wait()
        rms = np.sqrt(np.mean(rec**2))
        return {"suggested": max(0.001, float(rms * 2.5))}
    except: return {"suggested": 0.002}

@app.post("/api/chat")
async def chat(chat_msg: ChatMessage):
    global mega_agent_instance
    if not mega_agent_instance: return {"response": "Sem API Key."}
    res = mega_agent_instance.process_command(chat_msg.message)
    audio = await gerar_audio_base64(res)
    return {"response": res, "audio": audio}

@app.get("/api/events")
async def events(request: Request):
    async def gen():
        while True:
            if await request.is_disconnected(): break
            try: yield f"data: {json.dumps(await event_queue.get())}\n\n"
            except: break
    return StreamingResponse(gen(), media_type="text/event-stream")

# --- MOTOR DE ESCUTA (TWO-STAGE WAKE) ---
def voice_listener_loop(loop):
    fs = 16000
    is_processing = False
    print("[SISTEMA] Motor de Despertar Ativo. Aguardando 'MEGA'...")

    while True:
        threshold = current_config.get("sensitivity", 0.002)
        if not (mega_agent_instance and current_config["apiKey"]) or is_processing:
            time.sleep(0.5); continue
        try:
            with sd.InputStream(channels=1, samplerate=fs) as stream:
                # ETAPA 1: Monitoramento Silencioso (2.0s para pegar chamados mais longos)
                data, _ = stream.read(int(2.0 * fs)) 
                vol = np.linalg.norm(data) / np.sqrt(len(data))
                
                if vol > threshold:
                    # Captura rápida para ver se é o wake-word
                    fd, p1 = tempfile.mkstemp(suffix=".wav"); os.close(fd)
                    wavfile.write(p1, fs, data)
                    
                    files = {"file": open(p1, "rb")}
                    # Prompt direciona o Whisper a entender que o contexto tem 'Mega'
                    resp = requests.post("https://api.groq.com/openai/v1/audio/transcriptions", 
                                        headers={"Authorization": f"Bearer {current_config['apiKey']}"}, 
                                        files=files, data={"model": "whisper-large-v3-turbo", "language": "pt", "prompt": "Mega"})
                    files["file"].close(); os.unlink(p1)

                    if resp.status_code == 200:
                        text = resp.json().get("text", "").lower().strip()
                        if text: print(f"[ESCUTA] {text}")
                        # Dicionario fonetico expandido ao extremo:
                        wake_words = ["mega", "meiga", "meca", "nega", "amiga", "hey", "még", "vegas", "mika", "neca", "brega"]
                        
                        if any(w in text for w in wake_words):
                            print("[!] MEGA DESPERTO. Ouvindo comando...")
                            is_processing = True
                            # NOTIFICA FRONTEND IMEDIATAMENTE
                            asyncio.run_coroutine_threadsafe(event_queue.put({"type": "wake_detected"}), loop)
                            # BEEP DE ATIVAÇÃO
                            try: winsound.Beep(800, 150); winsound.Beep(1200, 150)
                            except: pass
                            
                            # ETAPA 2: Escuta de Comando Expandida (8s)
                            cmd_data, _ = stream.read(int(8.0 * fs))
                            fd, p2 = tempfile.mkstemp(suffix=".wav"); os.close(fd)
                            wavfile.write(p2, fs, cmd_data)
                            
                            files = {"file": open(p2, "rb")}
                            # Prompt com comandos de contexto pro Whisper nao inventar palavras
                            context_prompt = "Mega, Wallison, pesquisar, agendar, lembrete, YouTube, música, suporte, tocar."
                            resp = requests.post("https://api.groq.com/openai/v1/audio/transcriptions", 
                                                headers={"Authorization": f"Bearer {current_config['apiKey']}"}, 
                                                files=files, data={"model": "whisper-large-v3-turbo", "language": "pt", "prompt": context_prompt})
                            files["file"].close(); os.unlink(p2)
                            
                            if resp.status_code == 200:
                                comando = resp.json().get("text", "").strip()
                                if comando:
                                    res_text = mega_agent_instance.process_command(comando)
                                    audio_b64 = asyncio.run_coroutine_threadsafe(gerar_audio_base64(res_text), loop).result()
                                    asyncio.run_coroutine_threadsafe(event_queue.put({"type": "voice_response", "text": res_text, "audio": audio_b64}), loop)
                            
                            is_processing = False
        except Exception as e: 
            print(f"[ERR LISTENER] {e}")
            is_processing = False; time.sleep(1)

def load_config_from_disk():
    global mega_agent_instance
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            d = json.load(f); current_config.update(d)
            if d.get("apiKey"): mega_agent_instance = MegaAgent(current_config)

@app.on_event("startup")
def startup_event():
    load_config_from_disk()
    loop = asyncio.get_event_loop()
    threading.Thread(target=voice_listener_loop, args=(loop,), daemon=True).start()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
