import { useState, useEffect, useRef } from 'react';

// Endereço fixo para evitar erros de rede
const API_BASE = "http://127.0.0.1:8000";

function App() {
  const [activeTab, setActiveTab] = useState('chat');
  const [showInput, setShowInput] = useState(false);
  
  // Settings State
  const [modelType, setModelType] = useState('groq');
  const [apiKey, setApiKey] = useState('');
  const [systemEmail, setSystemEmail] = useState('');
  const [systemPassword, setSystemPassword] = useState('');
  const [message, setMessage] = useState('');
  const [sensitivity, setSensitivity] = useState(0.002);
  const [voiceVolume, setVoiceVolume] = useState(1.0);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [isListening, setIsListening] = useState(false);
  
  // Audio State
  const [audioLevel, setAudioLevel] = useState(0);
  const [availableMics, setAvailableMics] = useState([]);
  const [selectedMic, setSelectedMic] = useState('default');

  // Chat State
  const [chatMessages, setChatMessages] = useState([
    { role: 'assistant', text: 'PROTOCOLO MEGA EXECUTIVO ATIVADO. AGUARDANDO COMANDOS, SR. WALLISON.' }
  ]);
  const [inputMessage, setInputMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const chatEndRef = useRef(null);

  // Audio Context Ref
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);

  // --- Sincronização em Tempo Real ---
  useEffect(() => {
    let eventSource;
    function connectRadio() {
      eventSource = new EventSource(`${API_BASE}/api/events`);
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'wake_detected') {
            setIsListening(true);
            setTimeout(() => setIsListening(false), 8000);
          }
          
          if (data.type === 'voice_response') {
            setIsListening(false);
            setIsTyping(false);
            setChatMessages(prev => [...prev.slice(-6), { role: 'assistant', text: data.text }]);
            if (data.audio) playAudio(data.audio);
          }
        } catch (err) { console.error("[RADIO] Erro:", err); }
      };
      eventSource.onerror = (err) => {
        eventSource.close();
        setTimeout(connectRadio, 3000);
      };
    }
    connectRadio();
    return () => { if(eventSource) eventSource.close(); };
  }, []);

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
      const audio = new Audio(`data:audio/mp3;base64,${base64}`);
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
    setMessage("MAPEANDO FREQUÊNCIAS...");
    try {
      const resp = await fetch(`${API_BASE}/api/calibrate`);
      const data = await resp.json();
      if(data.suggested) {
        setSensitivity(data.suggested);
        setMessage(`ESTABILIZADO!`);
        handleSave(data.suggested);
      }
    } catch (err) { setMessage('ERRO SISTEMA'); }
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
      if (!newSens) setMessage('PROTOCOLO SINCRONIZADO.');
    } catch (err) { setMessage('ERRO COMUNICAÇÃO'); }
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

  const themeColor = isListening ? "#ffcc00" : (isCalibrating ? "#00ccff" : (isTyping ? "#ffffff" : "#ff7700"));

  return (
    <div className="min-h-screen bg-black text-orange-500 w-full flex flex-col items-center justify-center p-4 font-mono overflow-hidden select-none border-4 border-orange-950/40 box-border transition-colors duration-200" style={{ color: themeColor }}>
      
      {/* JARVIS High-Def Grid */}
      <div className="fixed inset-0 opacity-[0.15] pointer-events-none transition-all duration-300" style={{
        backgroundImage: `linear-gradient(${themeColor} 1px, transparent 1px), linear-gradient(90deg, ${themeColor} 1px, transparent 1px)`,
        backgroundSize: `${30 + (audioLevel/2)}px ${30 + (audioLevel/2)}px`,
        transform: `perspective(1000px) rotateX(15deg) scale(${1 + (audioLevel/800)})`
      }}></div>

      {/* Top Header Elite */}
      <div className="fixed top-4 left-4 right-4 flex justify-between items-start z-20">
        <div className="space-y-0">
          <h1 className="text-2xl font-black tracking-widest drop-shadow-[0_0_15px_rgba(255,100,0,0.8)] leading-none transition-colors italic" style={{ color: themeColor }}>MEGA_JARVIS</h1>
          <div className="flex items-center gap-3 text-[9px] tracking-[0.2em] uppercase font-black mt-2">
            <span className={`${audioLevel > (sensitivity * 5000) || isListening ? 'animate-pulse text-white' : 'opacity-30'}`}>
              {isListening ? 'LISTENING_MODE' : (isCalibrating ? 'CALIBRATING' : (audioLevel > (sensitivity * 5000) ? 'ACTIVE_LINK' : 'LINK_STANDBY'))}
            </span>
            <div className={`w-2 h-2 rounded-sm ${audioLevel > (sensitivity * 5000) ? 'animate-ping' : 'opacity-10'}`} style={{ backgroundColor: themeColor }}></div>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={() => setActiveTab('chat')} className={`p-3 border-2 rounded-sm transition-all duration-300 backdrop-blur-xl shadow-lg`} style={{ borderColor: `${themeColor}66`, backgroundColor: activeTab === 'chat' ? themeColor : 'rgba(0,0,0,0.5)' }}>
            <svg className="w-5 h-5 text-black" fill="currentColor" viewBox="0 0 20 20"><path d="M2 5a2 2 0 012-2h7a2 2 0 012 2v4a2 2 0 01-2 2H9l-3 3v-3H4a2 2 0 01-2-2V5z"></path></svg>
          </button>
          <button onClick={() => setActiveTab('settings')} className={`p-3 border-2 rounded-sm transition-all duration-300 backdrop-blur-xl shadow-lg`} style={{ borderColor: `${themeColor}66`, backgroundColor: activeTab === 'settings' ? themeColor : 'rgba(0,0,0,0.5)' }}>
            <svg className="w-5 h-5 text-black" fill="currentColor" viewBox="0 0 20 20"><path d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106a1.532 1.532 0 01-2.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"></path></svg>
          </button>
        </div>
      </div>

      {activeTab === 'chat' && (
        <div className="relative flex flex-col items-center justify-center transition-all duration-1000 mt-12 scale-105">
          
          {/* Data Streaks (Particles) */}
          <div className="absolute inset-[-200px] pointer-events-none opacity-60">
             {[...Array(15)].map((_, i) => (
               <div key={i} className="absolute w-[1px] h-[30px] rounded-full animate-streak" style={{
                 backgroundColor: themeColor,
                 left: `${Math.random() * 100}%`,
                 top: `${Math.random() * 100}%`,
                 animationDelay: `${Math.random() * 2}s`,
                 boxShadow: `0 0 15px ${themeColor}`,
                 opacity: Math.random()
               }}></div>
             ))}
          </div>

          <div className="relative w-80 h-80 flex items-center justify-center">
            
            {/* Scientific Rings Layer 1 (Outer) */}
            <svg className="absolute inset-[-40px] w-[calc(100%+80px)] h-[calc(100%+80px)] animate-[spin_60s_linear_infinite] opacity-30">
              <circle cx="50%" cy="50%" r="48%" fill="none" stroke={themeColor} strokeWidth="1" strokeDasharray="1 10" />
            </svg>

            {/* Scientific Rings Layer 2 (Mechanical) */}
            <svg className="absolute inset-[-20px] w-[calc(100%+40px)] h-[calc(100%+40px)] animate-[spin_20s_linear_infinite_reverse] opacity-50">
               <circle cx="50%" cy="50%" r="46%" fill="none" stroke={themeColor} strokeWidth="2" strokeDasharray="30 150" />
               <circle cx="50%" cy="50%" r="46%" fill="none" stroke="#fff" strokeWidth="1" strokeDasharray="5 300" className="opacity-40" />
            </svg>

            {/* Core Glow Pulse (JARVIS ARC REACTOR STYLE) */}
            <div className={`absolute inset-0 rounded-full blur-[40px] opacity-20 transition-all duration-300`} style={{ backgroundColor: themeColor, transform: `scale(${1.2 + (audioLevel/100)})` }}></div>
            
            {/* The Main Reactor Core */}
            <div 
              className={`absolute w-36 h-36 rounded-full flex flex-col items-center justify-center border-4 transition-all duration-150 z-10 ${
                isListening ? 'animate-ping scale-150 shadow-[0_0_150px_rgba(255,150,0,0.9)]' : ''
              }`}
              style={{ 
                transform: `scale(${1 + (audioLevel / 180)})`,
                borderColor: themeColor,
                boxShadow: `0 0 ${70 + audioLevel}px ${themeColor}, inset 0 0 30px ${themeColor}aa`,
                background: `radial-gradient(circle, ${themeColor}22 0%, #000 80%)`
              }}
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle,rgba(255,255,255,0.4)_0%,transparent_60%)] opacity-30"></div>
              
              {/* Inner Reactor Design */}
              <div className="absolute inset-4 border border-white/20 rounded-full"></div>
              <div className="absolute inset-8 border border-white/10 rounded-full animate-pulse"></div>

              <span className={`text-3xl font-black tracking-[-0.1em] transition-colors drop-shadow-[0_0_15px_#fff] ${isTyping || isListening ? 'animate-pulse text-white' : ''}`}>MEGA</span>
              
              {/* Radial Signal Reactivity */}
              <div className="absolute inset-[-15px] opacity-40">
                {[...Array(12)].map((_, i) => (
                  <div key={i} className="absolute w-[2px] h-[8px] bg-white" style={{
                    left: '50%',
                    top: '0',
                    transformOrigin: '50% 110px',
                    transform: `rotate(${i * 30}deg) scaleY(${1 + (audioLevel/100)})`,
                    opacity: audioLevel / 255
                  }}></div>
                ))}
              </div>
            </div>
            
            {/* Technical HUD Overlays */}
            <div className="absolute w-full h-full animate-[spin_10s_linear_infinite] opacity-60">
               <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1px] h-full bg-gradient-to-b from-transparent via-current to-transparent" style={{ color: themeColor }}></div>
               <div className="absolute left-0 top-1/2 -translate-y-1/2 h-[1px] w-full bg-gradient-to-r from-transparent via-current to-transparent" style={{ color: themeColor }}></div>
            </div>
          </div>

          {/* JARVIS Console Log (High Contrast) */}
          <div className="mt-20 w-[420px] h-32 overflow-y-auto no-scrollbar space-y-4 px-6 py-4 border-l-2 bg-black/80 backdrop-blur-sm" style={{ borderColor: themeColor }}>
            {chatMessages.map((msg, i) => (
              <div key={i} className={`text-[12px] tracking-[0.2em] leading-relaxed transition-all duration-300 ${msg.role === 'user' ? 'text-white/40 italic text-right' : 'text-white font-bold'}`}>
                 <span className="opacity-40 text-[9px] mr-2">[{msg.role === 'user' ? 'SIGNAL_IN' : 'COMMS_OUT'}]</span> {msg.text}
              </div>
            ))}
            <div ref={chatEndRef}></div>
          </div>
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="z-10 bg-black/95 border-2 p-8 rounded-sm w-[380px] h-[480px] overflow-y-auto no-scrollbar backdrop-blur-3xl shadow-[0_0_80px_#000] relative mt-4 scale-95 transition-all scroll-smooth" style={{ borderColor: themeColor }}>
          <div className="absolute top-2 left-2 text-[6px] opacity-30 font-black">STARK_INDUSTRIES // MK_42</div>
          <h2 className="text-xl font-black mb-10 border-b-2 pb-4 tracking-[0.5em] text-center uppercase drop-shadow-md" style={{ borderColor: `${themeColor}44` }}>OS_CONFIG</h2>
          
          <div className="space-y-10 text-[11px] font-black uppercase tracking-[0.3em]">
            
            <button onClick={handleCalibrate} disabled={isCalibrating} className={`w-full py-4 border-2 transition-all relative overflow-hidden group`} style={{ borderColor: themeColor }}>
              <div className="absolute inset-0 translate-x-[-100%] group-hover:translate-x-0 bg-white/10 transition-transform duration-500"></div>
              <span className={isCalibrating ? 'animate-pulse text-white' : ''}>{isCalibrating ? 'LINKING_BIOMETRICS...' : 'CALIBRAR_MÓDULOS'}</span>
            </button>

            <div className="space-y-4 pt-6 border-t border-white/10">
              <label className="text-[9px] opacity-40">AI_KERNEL_TYPE</label>
              <select value={modelType} onChange={e => setModelType(e.target.value)} className="w-full bg-black border-2 p-3 text-white outline-none focus:border-white transition-colors" style={{ borderColor: `${themeColor}22` }}>
                <option value="groq">GROQ_ENGINE (TURBO)</option>
                <option value="openai">GPT_ENGINE (COMPLEX)</option>
              </select>
              
              <label className="text-[9px] opacity-40 mt-4 block">ACCESS_ENCRYPTION_KEY</label>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} className="w-full bg-black border-2 p-3 text-white outline-none focus:border-white" style={{ borderColor: `${themeColor}22` }} />
            </div>

            <div className="space-y-8 pt-6 border-t border-white/10">
              <div className="space-y-4">
                <label className="text-[9px] opacity-40">AUDIO_OUTPUT: {(voiceVolume * 100).toFixed(0)}%</label>
                <input type="range" min="0" max="1" step="0.05" value={voiceVolume} onChange={e => setVoiceVolume(parseFloat(e.target.value))} className="w-full h-1 bg-white/10 accent-white appearance-none cursor-pointer" />
              </div>
              <div className="space-y-4">
                <label className="text-[9px] opacity-40">MIC_SENSITIVITY: {((1 - (sensitivity / 0.01)) * 100).toFixed(0)}%</label>
                <input type="range" min="0.0005" max="0.008" step="0.0005" value={sensitivity} onChange={e => setSensitivity(parseFloat(e.target.value))} className="w-full h-1 bg-white/10 accent-white rotate-180 appearance-none cursor-pointer" />
              </div>
            </div>

            <div className="sticky bottom-0 pt-8 bg-black pb-4 border-t border-white/10">
              <button onClick={() => handleSave()} className="w-full text-black font-black py-5 shadow-2xl transform active:scale-95 transition-all text-[14px]" style={{ backgroundColor: themeColor }}>ESTABELECER_LINK</button>
            </div>
            {message && <p className="text-center animate-bounce mt-4 text-[10px] font-black text-white">{`>> ${message}`}</p>}
          </div>
        </div>
      )}

      {/* JARVIS Tactical Input */}
      <div className="fixed bottom-12 z-30">
        {showInput ? (
          <form onSubmit={handleSendMessage} className="flex gap-2 bg-black/90 border-2 p-2 rounded-sm shadow-[0_0_60px_#000] w-[420px] animate-in zoom-in-95 duration-200" style={{ borderColor: themeColor }}>
            <input autoFocus type="text" value={inputMessage} onChange={e => setInputMessage(e.target.value)} placeholder="DIRECT_OVERRIDE..." className="bg-transparent px-6 py-4 flex-1 outline-none text-[13px] placeholder:text-white/20 uppercase font-black tracking-[0.3em] text-white"/>
            <button type="submit" className="text-black px-8 font-black text-[13px] hover:bg-white transition-all shadow-inner" style={{ backgroundColor: themeColor }}>SEND</button>
            <button type="button" onClick={() => setShowInput(false)} className="px-4 opacity-40 hover:opacity-100 text-2xl font-light transition-opacity">×</button>
          </form>
        ) : (
          <button onClick={() => setShowInput(true)} className="group relative p-8 border-2 bg-black/20 hover:bg-white/5 transition-all overflow-hidden" style={{ borderColor: `${themeColor}44` }}>
            <div className="absolute inset-0 bg-white/5 translate-y-[100%] group-hover:translate-y-0 transition-transform duration-300"></div>
            <svg className="w-8 h-8 transition-transform group-hover:scale-125" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: themeColor }}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path></svg>
            <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2" style={{ borderColor: themeColor }}></div>
            <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2" style={{ borderColor: themeColor }}></div>
          </button>
        )}
      </div>

      {/* CRT Scan & Noise Overlays */}
      <div className="fixed inset-0 pointer-events-none z-50 opacity-[0.04] pointer-events-none mix-blend-overlay">
        <div className="w-full h-full bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.5)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_4px,4px_100%]"></div>
      </div>

      <style>{`
        @keyframes streak {
          0% { transform: translateY(-100px) scaleY(0); opacity: 0; }
          50% { opacity: 1; transform: translateY(0) scaleY(1.5); }
          100% { transform: translateY(200px) scaleY(0); opacity: 0; }
        }
        .animate-streak { animation: streak 2.5s ease-in-out infinite; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}

export default App;
