
export interface Message {
  role: 'user' | 'doctor';
  text: string;
  timestamp: Date;
}

export interface SessionConfig {
  voiceName: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
  systemInstruction: string;
}
