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

class MegaAgent:
    def __init__(self, config):
        self.config = config
        self.llm = ChatGroq(api_key=config["apiKey"], model="llama-3.3-70b-versatile", temperature=0.3)
    
    def process_command(self, command_text):
        cmd = command_text.lower().strip()
        atalhos = {
            "suporte": "https://meganet-suport-git-main-wallison-rangels-projects.vercel.app/",
            "rede mega": "https://meganett.atlaz.com.br/admin",
            "atlaz": "https://meganett.atlaz.com.br/admin"
        }
        for kw, url in atalhos.items():
            if kw in cmd:
                webbrowser.open(url)
                return f"Iniciando acesso ao portal de {kw}, Sr. Wallison."
        try:
            prompt = f"""[SYSTEM] Você é o MEGA Executive, IA pessoal de Wallison Rangel.
Regras: Responda SEMPRE em Português (pt-BR). Use JSON:
- SEARCH: {{ "skill": "search", "query": "..." }}
- AGENDA_ADD: {{ "skill": "agenda_add", "text": "...", "time": "..." }}
- AGENDA_LIST: {{ "skill": "agenda_list" }}
- MEDIA: {{ "skill": "media", "action": "pause|play|next|prev" }}
- CHAT: {{ "skill": "none", "response": "..." }}
Horário: {datetime.now().strftime('%H:%M:%S')}
Input: "{command_text}" """
            resp = self.llm.invoke([HumanMessage(content=prompt)])
            data = json.loads(resp.content.replace('```json', '').replace('```', '').strip())
            skill = data.get("skill")
            if skill == "search":
                res = skill_pesquisar_web(data.get("query"))
                return self.llm.invoke([SystemMessage(content="Resuma em pt-BR."), HumanMessage(content=res)]).content
            elif skill == "agenda_add": return skill_agenda_lembrete(data.get("text"), data.get("time"))
            elif skill == "agenda_list": return skill_listar_agenda()
            elif skill == "media": return skill_controlar_midia(data.get("action"))
            return data.get("response", "Pronto.")
        except: return "Desculpe, Sr. Wallison, falha no núcleo."

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
                # ETAPA 1: Monitoramento Silencioso (1.5s)
                data, _ = stream.read(int(1.5 * fs)) 
                vol = np.linalg.norm(data) / np.sqrt(len(data))
                
                if vol > threshold:
                    # Captura rápida para ver se é o wake-word
                    fd, p1 = tempfile.mkstemp(suffix=".wav"); os.close(fd)
                    wavfile.write(p1, fs, data)
                    
                    files = {"file": open(p1, "rb")}
                    resp = requests.post("https://api.groq.com/openai/v1/audio/transcriptions", 
                                        headers={"Authorization": f"Bearer {current_config['apiKey']}"}, 
                                        files=files, data={"model": "whisper-large-v3-turbo", "language": "pt"})
                    files["file"].close(); os.unlink(p1)

                    if resp.status_code == 200:
                        text = resp.json().get("text", "").lower()
                        wake_words = ["mega", "meiga", "meca", "amiga", "hey"]
                        
                        if any(w in text for w in wake_words):
                            print("[!] MEGA DESPERTO. Ouvindo comando...")
                            is_processing = True
                            # NOTIFICA FRONTEND IMEDIATAMENTE
                            asyncio.run_coroutine_threadsafe(event_queue.put({"type": "wake_detected"}), loop)
                            # BEEP DE ATIVAÇÃO
                            try: winsound.Beep(800, 150); winsound.Beep(1200, 150)
                            except: pass
                            
                            # ETAPA 2: Escuta de Comando (5s)
                            cmd_data, _ = stream.read(int(5.0 * fs))
                            fd, p2 = tempfile.mkstemp(suffix=".wav"); os.close(fd)
                            wavfile.write(p2, fs, cmd_data)
                            
                            files = {"file": open(p2, "rb")}
                            resp = requests.post("https://api.groq.com/openai/v1/audio/transcriptions", 
                                                headers={"Authorization": f"Bearer {current_config['apiKey']}"}, 
                                                files=files, data={"model": "whisper-large-v3-turbo", "language": "pt"})
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
