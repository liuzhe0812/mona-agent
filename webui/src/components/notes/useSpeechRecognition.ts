import { useCallback, useEffect, useRef, useState } from "react";

// 浏览器原生 Web Speech API 类型（Tauri WebView2 / Edge 内核支持）
// 无需 API Key、无需后端、无需打包模型，对标 edge-tts 的免费方案。
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseSpeechRecognitionOptions {
  lang?: string;
  // 每次收到最终结果时触发（累加式，用于实时写入笔记）
  onFinalChunk?: (text: string) => void;
  // 中间结果回调（用于实时显示未确定的文字）
  onInterim?: (text: string) => void;
}

export interface UseSpeechRecognitionResult {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
}

/**
 * 封装浏览器原生 SpeechRecognition。
 *
 * 浏览器实现会自动超时（约 60 秒静音或一段时间后强制 end），
 * 这里在 onend 时如果仍处于 listening 状态就自动重启，保证会议长录音不中断。
 */
export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {},
): UseSpeechRecognitionResult {
  const { lang = "zh-CN", onFinalChunk, onInterim } = options;
  const Ctor = getSpeechRecognitionCtor();
  const supported = Ctor !== null;

  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantListeningRef = useRef(false);
  // 持久化最新回调，避免 effect 频繁重建 recognition 实例
  const onFinalChunkRef = useRef(onFinalChunk);
  const onInterimRef = useRef(onInterim);
  useEffect(() => {
    onFinalChunkRef.current = onFinalChunk;
    onInterimRef.current = onInterim;
  }, [onFinalChunk, onInterim]);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // 忽略
      }
    }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    if (!Ctor) {
      setError("当前浏览器不支持语音识别（需 Edge / WebView2 内核）");
      return;
    }
    setError(null);
    wantListeningRef.current = true;

    // 每次启动创建新实例，避免复用旧实例的状态
    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setListening(true);
    };
    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          onFinalChunkRef.current?.(text);
        } else {
          interim += text;
        }
      }
      if (interim) onInterimRef.current?.(interim);
    };
    rec.onerror = (event) => {
      // no-speech / aborted 是正常的中途状态，不当作错误
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("麦克风权限被拒绝");
        wantListeningRef.current = false;
        setListening(false);
        return;
      }
      setError(event.message || event.error || "语音识别出错");
    };
    rec.onend = () => {
      // 浏览器会在静音或一段时间后自动 end。如果用户没有主动 stop，自动重启。
      if (wantListeningRef.current) {
        try {
          rec.start();
          return;
        } catch {
          // 立即重启可能抛 InvalidStateError，等下一个事件循环再试
        }
        const timer = window.setTimeout(() => {
          if (wantListeningRef.current && recognitionRef.current === rec) {
            try {
              rec.start();
            } catch {
              setListening(false);
              wantListeningRef.current = false;
            }
          }
        }, 250);
        // 清理：在 unmount 时由外层 effect 负责
        void timer;
      } else {
        setListening(false);
      }
    };

    try {
      rec.start();
    } catch (e) {
      setError(String(e));
      wantListeningRef.current = false;
    }
  }, [Ctor, lang]);

  // 卸载时清理
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      const rec = recognitionRef.current;
      if (rec) {
        try {
          rec.abort();
        } catch {
          // 忽略
        }
      }
    };
  }, []);

  return { supported, listening, error, start, stop };
}
