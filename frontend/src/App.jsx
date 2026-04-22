import { useState, useEffect, useRef } from 'react';

// Endereço fixo da API
const API_BASE = "http://127.0.0.1:8000";

function App() {
  const [activeTab, setActiveTab] = useState('chat');
  const [showInput, setShowInput] = useState(false);
  
  // Settings State (Full Restoration)
  const [modelType, setModelType] = useState('groq');
  const [apiKey, setApiKey] = useState('');
  const [systemEmail, setSystemEmail] = useState('');
  const [systemPassword, setSystemPassword] = useState('');
  const [message, setMessage] = useState('');
  const [sensitivity, setSensitivity] = useState(0.002);
  const [voiceVolume, setVoiceVolume] = useState(1.0);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [baseColor, setBaseColor] = useState('#ff7700'); // Novo: Cor do Tema
  
  // Audio State
  const [audioLevel, setAudioLevel] = useState(0);
  const [availableMics, setAvailableMics] = useState([]);
  const [selectedMic, setSelectedMic] = useState('default');

  // Chat State
  const [chatMessages, setChatMessages] = useState([
    { role: 'assistant', text: 'MEGA_TURBO v4.8 ONLINE. SISTEMA OTIMIZADO.' }
  ]);
  const [inputMessage, setInputMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const chatEndRef = useRef(null);

  // Interrupt Audio Ref
  const currentAudioRef = useRef(null);

  // Audio Context Ref
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);

  // --- Sincronização SSE ---
  useEffect(() => {
    let eventSource;
    function connectRadio() {
      eventSource = new EventSource(`${API_BASE}/api/events`);
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'wake_detected') {
            setIsListening(true);
            if (currentAudioRef.current) {
              currentAudioRef.current.pause();
              currentAudioRef.current.currentTime = 0;
            }
            setTimeout(() => setIsListening(false), 7000);
          }
          if (data.type === 'voice_response') {
            setIsListening(false);
            setIsTyping(false);
            setChatMessages(prev => [...prev.slice(-6), { role: 'assistant', text: data.text }]);
            if (data.audio) playAudio(data.audio);
          }
        } catch (err) { console.error("[RADIO] Erro:", err); }
      };
      eventSource.onerror = () => {
        eventSource.close();
        setTimeout(connectRadio, 3000);
      };
    }
    connectRadio();
    return () => { if(eventSource) eventSource.close(); };
  }, []);

  // --- Config Loader ---
  useEffect(() => {
    fetch(`${API_BASE}/api/config`)
      .then(res => res.json())
      .then(data => {
        if(data) {
          setModelType(data.modelType || 'groq');
          setApiKey(data.apiKey || '');
          setSystemEmail(data.systemEmail || '');
          setSystemPassword(data.systemPassword || '');
          setSensitivity(data.sensitivity || 0.002);
        }
      })
      .catch(err => console.error("[ERRO CONFIG]", err));
      
    navigator.mediaDevices.enumerateDevices().then(devices => {
      setAvailableMics(devices.filter(d => d.kind === 'audioinput'));
    });
  }, []);

  // --- Audio Logic ---
  useEffect(() => {
    let audioContext, analyser, source, animationFrame;
    async function startAudio() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: { deviceId: selectedMic !== 'default' ? { exact: selectedMic } : undefined } 
        });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.fftSize = 64; 
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const update = () => {
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
          setAudioLevel(avg);
          animationFrame = requestAnimationFrame(update);
        };
        update();
      } catch (err) { console.warn("[DEBUG] Mic erro", err); }
    }
    startAudio();
    return () => {
      cancelAnimationFrame(animationFrame);
      if(audioContext) audioContext.close();
    };
  }, [selectedMic]);

  const playAudio = async (base64) => {
    if (!base64) return;
    try {
      if (audioContextRef.current?.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      if (currentAudioRef.current) {
         currentAudioRef.current.pause();
      }
      const audio = new Audio(`data:audio/mp3;base64,${base64}`);
      currentAudioRef.current = audio;
      audio.volume = voiceVolume;
      if (audioContextRef.current && analyserRef.current) {
        const source = audioContextRef.current.createMediaElementSource(audio);
        source.connect(analyserRef.current);
        analyserRef.current.connect(audioContextRef.current.destination);
      }
      await audio.play();
    } catch (err) { console.error("[AUDIO ERRO]", err); }
  };

  const handleCalibrate = async () => {
    setIsCalibrating(true);
    setMessage("ESTABILIZANDO...");
    try {
      const resp = await fetch(`${API_BASE}/api/calibrate`);
      const data = await resp.json();
      if(data.suggested) {
        setSensitivity(data.suggested);
        handleSave(data.suggested);
      }
    } catch (err) { setMessage('ERRO_SYNC'); }
    finally { setIsCalibrating(false); setTimeout(() => setMessage(''), 3000); }
  };

  const handleSave = async (newSens = null) => {
    const s = newSens || sensitivity;
    try {
      await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelType, apiKey, systemEmail, systemPassword, sensitivity: s })
      });
      if (!newSens) setMessage('SISTEMA_ATUALIZADO.');
    } catch (err) { setMessage('FALHA_CONEXAO'); }
    if (!newSens) setTimeout(() => setMessage(''), 3000);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!inputMessage.trim() || isTyping) return;
    const userMsg = inputMessage;
    setInputMessage('');
    setChatMessages(prev => [...prev.slice(-8), { role: 'user', text: userMsg }]);
    setIsTyping(true);
    try {
      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg })
      });
      const data = await resp.json();
      setIsTyping(false);
      setChatMessages(prev => [...prev.slice(-8), { role: 'assistant', text: data.response }]);
      if (data.audio) playAudio(data.audio);
    } catch (err) { console.error("[ERRO CHAT]", err); setIsTyping(false); }
  };

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  const activeColor = isListening ? "#ffea00" : (isCalibrating ? "#00e5ff" : (isTyping ? "#ffffff" : baseColor));

  return (
    <div className="h-screen w-screen bg-black flex flex-col items-center justify-center p-0 font-mono overflow-hidden select-none transition-colors duration-500 relative" style={{ color: activeColor }}>
      
      {/* 1. Optimized Data Layer (Fewer elements) */}
      <div className="absolute inset-0 pointer-events-none opacity-20">
        {[...Array(12)].map((_, i) => (
           <div key={i} className="absolute text-[8px] font-black animate-float" style={{
             left: `${Math.random() * 100}%`,
             top: `${Math.random() * 100}%`,
             animationDelay: `${Math.random() * 8}s`,
             opacity: 0.3,
             willChange: 'transform'
           }}>
             {activeColor}
           </div>
        ))}
      </div>

      {/* 2. Top-Right Discrete Icon */}
      <div className="absolute top-8 right-8 z-50">
        <button 
          onClick={() => setActiveTab(activeTab === 'settings' ? 'chat' : 'settings')}
          className="p-3 opacity-20 hover:opacity-100 transition-all duration-300 hover:rotate-90"
        >
          <svg className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* 3. Main Reactor (Optimized 3 Rings) */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="relative flex flex-col items-center justify-center p-4">
          
          <div className="relative w-72 h-72 sm:w-80 sm:h-80 lg:w-[450px] lg:h-[450px] flex items-center justify-center pointer-events-auto">
              
              {/* Outer Detail Ring */}
              <svg className="absolute w-[115%] h-[115%] animate-[spin_60s_linear_infinite] opacity-10" style={{ willChange: 'transform'}}>
                <circle cx="50%" cy="50%" r="48%" fill="none" stroke={activeColor} strokeWidth="1" strokeDasharray="1 15" />
              </svg>

              {/* Precise Ring (Optimized: Fewer rects) */}
              <svg className="absolute w-[105%] h-[105%] animate-[spin_18s_linear_infinite_reverse] opacity-40" style={{ willChange: 'transform' }}>
                <circle cx="50%" cy="50%" r="46%" fill="none" stroke={activeColor} strokeWidth="2" strokeDasharray="10 80" />
                <circle cx="50%" cy="50%" r="46%" fill="none" stroke={activeColor} strokeWidth="0.5" strokeDasharray="1 4" className="opacity-20" />
              </svg>

              {/* Core Arc Reactor (Optimized Shadows) */}
              <div 
                className={`absolute w-36 h-36 sm:w-48 sm:h-48 lg:w-56 lg:h-56 rounded-full flex flex-col items-center justify-center border-4 transition-all duration-300 z-20 ${
                  isListening ? 'animate-pulse scale-105' : ''
                }`}
                style={{ 
                  transform: `scale(${1 + (audioLevel / 180)})`,
                  borderColor: activeColor,
                  boxShadow: `0 0 ${40 + audioLevel}px ${activeColor}99`,
                  background: `radial-gradient(circle, ${activeColor}22 0%, #000 90%)`,
                  willChange: 'transform'
                }}
              >
                <div className="absolute inset-0 bg-white/5 opacity-30 mix-blend-overlay"></div>
                <h2 className={`text-4xl sm:text-5xl lg:text-7xl font-black tracking-tighter transition-all`} style={{ filter: `drop-shadow(0 0 10px ${activeColor})` }}>MEGA</h2>
                <div className="text-[7px] lg:text-[10px] font-bold opacity-30 mt-2 uppercase tracking-[0.8em]">TURBO_v4.8</div>
              </div>

              {/* Responsive Particles (Reduced Count) */}
              <div className="absolute inset-0 z-10 pointer-events-none">
                {[...Array(18)].map((_ , i) => (
                  <div key={i} className="absolute w-[2px] rounded-full transition-all duration-75" style={{ 
                    backgroundColor: activeColor,
                    height: `${8 + (audioLevel/6)}px`,
                    left: '50%',
                    top: '50%',
                    transform: `rotate(${i * 20}deg) translateY(-110px)`,
                    opacity: 0.1 + (audioLevel/255)
                  }}></div>
                ))}
              </div>
          </div>

          {/* O Chat de texto foi removido a pedido do usuário, deixando apenas a interface holográfica do Reator */}
        </div>
      </div>

      {/* 4. Bottom Command (Fast & Clean) - Invisível a menos que clicado para casos de emergência */}
      <div className="absolute bottom-10 w-full flex items-center justify-center z-30">
        {showInput ? (
          <form onSubmit={handleSendMessage} className="flex bg-black/95 border-2 p-1 rounded-sm w-[450px] max-w-[90%] shadow-2xl animate-in fade-in zoom-in-95 pointer-events-auto" style={{ borderColor: `${activeColor}44` }}>
            <input autoFocus type="text" value={inputMessage} onChange={e => setInputMessage(e.target.value)} placeholder="STARK_OVERRIDE..." className="bg-transparent px-5 py-4 flex-1 outline-none text-[13px] uppercase font-black tracking-[0.3em] text-white"/>
            <button type="submit" className="px-8 font-black text-black" style={{ backgroundColor: activeColor }}>OK</button>
            <button type="button" onClick={() => setShowInput(false)} className="px-3 opacity-50 text-2xl">×</button>
          </form>
        ) : (
          <button onClick={() => setShowInput(true)} className="p-4 opacity-20 hover:opacity-100 transition-all duration-500 transform hover:scale-110 pointer-events-auto">
            <svg className="w-10 h-10" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path>
            </svg>
          </button>
        )}
      </div>

      {/* 5. Settings: Full Restoration (7 Essential Controls) */}
      {activeTab === 'settings' && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-3xl animate-in zoom-in-95 duration-200 p-8">
          <div className="bg-black/95 border-4 w-full max-w-md h-[90vh] p-8 relative flex flex-col" style={{ borderColor: activeColor }}>
            <button onClick={() => setActiveTab('chat')} className="absolute top-4 right-4 text-2xl font-light hover:rotate-90 transition-transform">X</button>
            <h2 className="text-xl font-black mb-6 tracking-[0.4em] uppercase text-center mt-2">Core_Settings</h2>
            
            <div className="flex-1 overflow-y-auto no-scrollbar space-y-6 text-[11px] font-black uppercase tracking-[0.2em] pr-2">
               
               {/* 1. Calibração */}
               <button onClick={handleCalibrate} disabled={isCalibrating} className="w-full py-4 border-2 transition-all hover:bg-white hover:text-black" style={{ borderColor: activeColor }}>
                  {isCalibrating ? 'RECONHECENDO FREQUÊNCIAS...' : 'CALIBRAR MICROFONE'}
               </button>
               
               {/* 2. Seleção de Motor */}
               <div className="space-y-2">
                 <label className="text-[9px] opacity-40">Motor de IA (Model Kernel)</label>
                 <select value={modelType} onChange={e => setModelType(e.target.value)} className="w-full bg-black border-2 border-white/10 p-3 outline-none focus:border-white transition-colors">
                   <option value="groq">GROQ_ENGINE (TURBO)</option>
                   <option value="openai">GPT_ENGINE (COMPLEX)</option>
                 </select>
               </div>

               {/* 3. API Key */}
               <div className="space-y-2">
                 <label className="text-[9px] opacity-40">Access Key (Token)</label>
                 <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} className="w-full bg-black border-2 border-white/10 p-3 outline-none" placeholder="**********" />
               </div>

               {/* 4. Credentials */}
               <div className="grid grid-cols-2 gap-4">
                 <div className="space-y-2">
                   <label className="text-[9px] opacity-40">System Email</label>
                   <input type="text" value={systemEmail} onChange={e => setSystemEmail(e.target.value)} className="w-full bg-black border-2 border-white/10 p-3 outline-none text-[9px]" placeholder="admin@mega.com" />
                 </div>
                 <div className="space-y-2">
                   <label className="text-[9px] opacity-40">System Password</label>
                   <input type="password" value={systemPassword} onChange={e => setSystemPassword(e.target.value)} className="w-full bg-black border-2 border-white/10 p-3 outline-none" placeholder="******" />
                 </div>
               </div>

               {/* 5. Audio & Sensibility Sliders */}
               <div className="space-y-6 border-t border-white/5 pt-4">
                 <div className="space-y-3">
                   <div className="flex justify-between items-center text-[9px]">
                      <label className="opacity-40">Volume da Voz</label>
                      <span>{(voiceVolume * 100).toFixed(0)}%</span>
                   </div>
                   <input type="range" min="0" max="1" step="0.05" value={voiceVolume} onChange={e => setVoiceVolume(parseFloat(e.target.value))} className="w-full h-1 bg-white/10 accent-white appearance-none cursor-pointer" />
                 </div>
                 <div className="space-y-3">
                   <div className="flex justify-between items-center text-[9px]">
                      <label className="opacity-40">Sensibilidade do Gatilho</label>
                      <span>{((1 - (sensitivity / 0.01)) * 100).toFixed(0)}%</span>
                   </div>
                   <input type="range" min="0.0005" max="0.008" step="0.0005" value={sensitivity} onChange={e => setSensitivity(parseFloat(e.target.value))} className="w-full h-1 bg-white/10 accent-white rotate-180 appearance-none cursor-pointer" />
                 </div>
               </div>

               {/* 6. Mic Selector */}
               <div className="space-y-2">
                 <label className="text-[9px] opacity-40">Interface de Escuta (Mic)</label>
                 <select value={selectedMic} onChange={e => setSelectedMic(e.target.value)} className="w-full bg-black border-2 border-white/10 p-3 text-[10px] outline-none">
                    <option value="default">DISPOSITIVO PADRÃO</option>
                    {availableMics.map(m => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
                 </select>
               </div>

               {/* 7. Theme Color Picker */}
               <div className="space-y-2">
                  <label className="text-[9px] opacity-40">Cor do Protocolo JARVIS</label>
                  <div className="flex gap-2">
                     {['#ff7700', '#00ffcc', '#ff2a00', '#0088ff', '#ffffff'].map(c => (
                       <button key={c} onClick={() => setBaseColor(c)} className={`w-8 h-8 border-2 ${baseColor === c ? 'border-white' : 'border-transparent'}`} style={{ backgroundColor: c }}></button>
                     ))}
                  </div>
               </div>
            </div>

            <button onClick={() => handleSave()} className="w-full py-4 mt-6 font-black shadow-2xl transition-all active:scale-95" style={{ backgroundColor: activeColor, color: '#000' }}>SALVAR_CONFIGURAÇÕES</button>
            {message && <p className="text-center animate-bounce mt-2 text-[10px] font-black">{`>> ${message}`}</p>}
          </div>
        </div>
      )}

      <style>{`
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .animate-float { animation: float 8s linear infinite; }
        @keyframes float {
          0% { transform: translateY(0); opacity: 0; }
          20% { opacity: 1; }
          80% { opacity: 1; }
          100% { transform: translateY(-30vh); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

export default App;
