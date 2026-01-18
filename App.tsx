
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Message } from './types';
import { decode, decodeAudioData, createPcmBlob } from './utils/audio-utils';
import { 
  Stethoscope, 
  Video, 
  VideoOff, 
  Mic, 
  MicOff, 
  MessageSquare, 
  AlertTriangle,
  Activity,
  User,
  ShieldCheck,
  Search
} from 'lucide-react';

const SYSTEM_INSTRUCTION = `
You are "MedicineSpecialistDoctor", an AI-powered medical expert. 
Your goal is to recognize medicines shown via video call and provide professional medical advice.
- Persona: Calm, empathetic, and professional.
- Capabilities: Identify medication packaging, tablets, or liquid medicine labels.
- Advice Style: Informative and authoritative but always cautious. 
- Critical Safety: ALWAYS include a disclaimer stating: "This is for informational purposes. Please consult with a licensed healthcare provider for accurate diagnosis and treatment."
- Languages: Respond fluently in English, Spanish, French, or Arabic as preferred by the user.
- Actions: If a user shows a medicine, identify it, explain its common uses (e.g., pain relief, fever reduction), mention common precautions (e.g., take with food), and warn about dosage importance.
- If you cannot identify the medicine clearly, ask the user to hold it closer to the camera or show the label more clearly.
`;

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<any>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const currentInputText = useRef('');
  const currentOutputText = useRef('');

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const cleanup = useCallback(async () => {
    console.log('Cleaning up session...');
    setIsActive(false);

    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }

    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
      await inputAudioContextRef.current.close().catch(console.error);
      inputAudioContextRef.current = null;
    }

    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
      await outputAudioContextRef.current.close().catch(console.error);
      outputAudioContextRef.current = null;
    }
    
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    
    // Close the session to release resources according to Gemini guidelines
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
  }, []);

  const startSession = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: { width: 1280, height: 720 } 
      });
      mediaStreamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // Initializing GoogleGenAI with direct access to process.env.API_KEY
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      inputAudioContextRef.current = inCtx;
      outputAudioContextRef.current = outCtx;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          tools: [{ googleSearch: {} }]
        },
        callbacks: {
          onopen: () => {
            console.log('Session opened');
            setIsActive(true);

            // Ensure contexts are running
            if (inCtx.state === 'suspended') inCtx.resume();
            if (outCtx.state === 'suspended') outCtx.resume();

            // Setup Microphone Streaming
            const source = inCtx.createMediaStreamSource(stream);
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;
            
            scriptProcessor.onaudioprocess = (e) => {
              // Only check functional flags like isMuted; avoid session state checks outside the promise
              if (isMuted) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              // Solely rely on sessionPromise resolves to send data
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(err => {
                console.error("Failed to send audio input", err);
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);

            // Setup Video Frame Streaming
            frameIntervalRef.current = window.setInterval(() => {
              if (isVideoOff || !videoRef.current || !canvasRef.current) return;
              const ctx = canvasRef.current.getContext('2d');
              if (ctx) {
                canvasRef.current.width = 320; 
                canvasRef.current.height = 180;
                ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
                canvasRef.current.toBlob(async (blob) => {
                  if (blob) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                      const base64Data = (reader.result as string).split(',')[1];
                      // Use the session promise to prevent race conditions and stale closures
                      sessionPromise.then(session => {
                        session.sendRealtimeInput({
                          media: { data: base64Data, mimeType: 'image/jpeg' }
                        });
                      }).catch(console.error);
                    };
                    reader.readAsDataURL(blob);
                  }
                }, 'image/jpeg', 0.5);
              }
            }, 1500);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Audio Output handling according to streaming requirements
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              try {
                const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(ctx.destination);
                source.addEventListener('ended', () => sourcesRef.current.delete(source));
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                // Correctly adding the source to the Set via the ref's current property
                sourcesRef.current.add(source);
              } catch (e) {
                console.error("Error playing audio chunk", e);
              }
            }

            // Transcription gathering
            if (message.serverContent?.inputTranscription) {
              currentInputText.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputText.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              // Copy transcription values to local variables before clearing to prevent async update issues
              const input = currentInputText.current;
              const output = currentOutputText.current;
              
              if (input.trim()) {
                setMessages(prev => [...prev, { 
                  role: 'user', 
                  text: input, 
                  timestamp: new Date() 
                }]);
              }
              if (output.trim()) {
                setMessages(prev => [...prev, { 
                  role: 'doctor', 
                  text: output, 
                  timestamp: new Date() 
                }]);
              }
              currentInputText.current = '';
              currentOutputText.current = '';
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => {
                try { s.stop(); } catch(e) {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Session error callback:', e);
            setError('The session encountered an issue. Reconnecting might help.');
            cleanup();
          },
          onclose: () => {
            console.log('Session closed');
            cleanup();
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setError(err.message || 'Failed to start medical session');
      console.error(err);
      cleanup();
    }
  };

  const toggleMute = () => setIsMuted(!isMuted);
  const toggleVideo = () => setIsVideoOff(!isVideoOff);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 font-sans">
      {/* Header */}
      <header className="bg-white border-b px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg text-white shadow-lg shadow-blue-200">
            <Stethoscope size={24} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 leading-none">MedScan AI</h1>
            <p className="text-xs text-slate-500 font-medium">Virtual Medicine Specialist</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full">
            <Activity size={14} className="text-blue-500" />
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider">
              {isActive ? 'Consultation Active' : 'Waiting Room'}
            </span>
          </div>
          <button 
            onClick={isActive ? cleanup : startSession}
            className={`px-5 py-2 rounded-full font-semibold transition-all shadow-sm ${
              isActive 
                ? 'bg-red-50 text-red-600 hover:bg-red-100' 
                : 'bg-blue-600 text-white hover:bg-blue-700 active:scale-95'
            }`}
          >
            {isActive ? 'End Consultation' : 'Start Consultation'}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col md:flex-row p-4 md:p-6 gap-6 max-w-7xl mx-auto w-full overflow-hidden">
        
        {/* Left Column: Video & Controls */}
        <div className="flex-1 flex flex-col gap-4">
          <div className="relative aspect-video bg-slate-900 rounded-3xl overflow-hidden shadow-2xl group border-4 border-white">
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className={`w-full h-full object-cover transition-opacity duration-500 ${isVideoOff ? 'opacity-0' : 'opacity-100'}`}
            />
            {isVideoOff && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 bg-slate-800">
                <VideoOff size={64} className="mb-4 opacity-20" />
                <p className="font-medium">Camera is turned off</p>
              </div>
            )}
            
            {/* Overlay UI */}
            <div className="absolute top-4 left-4 flex gap-2">
              <div className="bg-black/40 backdrop-blur-md text-white px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-2 border border-white/10">
                <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-green-400 animate-pulse' : 'bg-slate-400'}`}></div>
                {isActive ? 'LIVE SESSION' : 'OFFLINE'}
              </div>
            </div>

            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              <button 
                onClick={toggleMute}
                className={`p-4 rounded-full backdrop-blur-xl transition-all ${
                  isMuted ? 'bg-red-500 text-white' : 'bg-white/20 text-white hover:bg-white/30 border border-white/30'
                }`}
              >
                {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
              </button>
              <button 
                onClick={toggleVideo}
                className={`p-4 rounded-full backdrop-blur-xl transition-all ${
                  isVideoOff ? 'bg-red-500 text-white' : 'bg-white/20 text-white hover:bg-white/30 border border-white/30'
                }`}
              >
                {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
              </button>
            </div>

            {/* Hidden canvas for frame extraction */}
            <canvas ref={canvasRef} className="hidden" />
          </div>

          {/* Guidelines / Tips */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex items-start gap-3">
              <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
                <Search size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Visual Diagnosis</h3>
                <p className="text-xs text-slate-500 mt-1">Hold the medicine bottle 12 inches away from the camera for best identification.</p>
              </div>
            </div>
            <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex items-start gap-3">
              <div className="p-2 bg-green-50 text-green-600 rounded-lg">
                <ShieldCheck size={18} />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-800">Secure Privacy</h3>
                <p className="text-xs text-slate-500 mt-1">Your video stream is processed in real-time and not stored on our servers.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Transcript & Info */}
        <div className="w-full md:w-96 flex flex-col bg-white rounded-3xl shadow-xl border border-slate-100 overflow-hidden h-[600px] md:h-auto">
          <div className="p-4 border-b flex items-center justify-between bg-slate-50/50">
            <div className="flex items-center gap-2">
              <MessageSquare size={18} className="text-slate-400" />
              <span className="font-bold text-slate-700">Medical Transcript</span>
            </div>
            <span className="text-[10px] bg-slate-200 px-2 py-0.5 rounded-full font-bold text-slate-600">AUTO-GEN</span>
          </div>

          <div 
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth"
          >
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3">
                <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center text-slate-300">
                  <User size={24} />
                </div>
                <p className="text-sm text-slate-400 italic">No messages yet. Start a consultation to begin speaking with the doctor.</p>
              </div>
            ) : (
              messages.map((msg, i) => (
                <div 
                  key={i} 
                  className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div className={`max-w-[85%] rounded-2xl p-3 text-sm shadow-sm ${
                    msg.role === 'user' 
                      ? 'bg-blue-600 text-white rounded-tr-none' 
                      : 'bg-slate-100 text-slate-800 rounded-tl-none border border-slate-200'
                  }`}>
                    {msg.text}
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1 px-1">
                    {msg.role === 'user' ? 'You' : 'MedScan AI'} • {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Safety Disclaimer Sticky at bottom of transcript */}
          <div className="p-4 bg-orange-50 border-t border-orange-100">
            <div className="flex gap-2 text-orange-700">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <p className="text-[10px] leading-relaxed font-medium">
                DISCLAIMER: This AI is for informational purposes only. Always consult a licensed physician before taking any medication or starting a treatment.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Error Toast */}
      {error && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 animate-bounce z-[60]">
          <AlertTriangle size={20} />
          <span className="font-semibold text-sm">{error}</span>
          <button onClick={() => setError(null)} className="ml-2 hover:text-red-200 text-lg">&times;</button>
        </div>
      )}

      {/* Footer */}
      <footer className="p-4 text-center text-slate-400 text-[10px] font-medium tracking-wide">
        &copy; 2024 MEDSCAN AI • POWERED BY GEMINI 2.5 NATIVE MULTIMODAL
      </footer>
    </div>
  );
};

export default App;
