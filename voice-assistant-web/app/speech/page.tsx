"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status =
  | "idle"
  | "listening"
  | "speaking"
  | "transcribing"
  | "error";

const BRIDGE_URL = "http://127.0.0.1:8765/transcribe";

// ===============================
// VAD CONFIG
// ===============================

// Mức âm thanh để coi là "đang nói".
// Nếu microphone quá nhạy / quá nhỏ, chỉnh giá trị này.
const VAD_THRESHOLD = 0.025;

// Sau khi đã nói, nếu im lặng trong khoảng này → tự kết thúc.
// 1300ms = 1.3 giây.
const SILENCE_DURATION = 1300;

// Không tự stop trong khoảng thời gian đầu.
// Tránh việc vừa bật microphone đã bị coi là silence.
const MIN_RECORDING_DURATION = 700;

// Không bắt đầu VAD cho đến khi người dùng thực sự nói.
// Đây là thời gian tối đa chờ người dùng bắt đầu nói.
const SPEECH_START_TIMEOUT = 10000;

export default function SpeechPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");

  const [volume, setVolume] = useState(0);

  // ===============================
  // MEDIA
  // ===============================

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // ===============================
  // AUDIO / VAD
  // ===============================

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const chunksRef = useRef<Blob[]>([]);

  const recordingStartedAtRef = useRef<number>(0);
  const speechStartedAtRef = useRef<number | null>(null);
  const lastSpeechAtRef = useRef<number>(0);

  const hasDetectedSpeechRef = useRef(false);

  const isStoppingRef = useRef(false);

  // ===============================
  // CLEANUP AUDIO
  // ===============================

  const cleanupAudio = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    analyserRef.current = null;

    setVolume(0);
  }, []);

  // ===============================
  // CLEANUP MICROPHONE
  // ===============================

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop();
      });

      streamRef.current = null;
    }
  }, []);

  // ===============================
  // STOP EVERYTHING
  // ===============================

  const cleanupAll = useCallback(() => {
    cleanupAudio();
    cleanupStream();

    mediaRecorderRef.current = null;

    speechStartedAtRef.current = null;
    lastSpeechAtRef.current = 0;
    hasDetectedSpeechRef.current = false;
    isStoppingRef.current = false;
  }, [cleanupAudio, cleanupStream]);

  // ===============================
  // TRANSCRIBE
  // ===============================

  const transcribe = useCallback(async (audioBlob: Blob) => {
    try {
      setStatus("transcribing");
      setError("");

      const formData = new FormData();

      formData.append(
        "file",
        audioBlob,
        getFileName(audioBlob.type)
      );

      // Python bridge có thể dùng field này
      formData.append("language", "vi");

      console.log(
        "[ASR] Sending audio:",
        audioBlob.type,
        audioBlob.size
      );

      const response = await fetch(BRIDGE_URL, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const responseText = await response.text();

        throw new Error(
          `ASR server ${response.status}: ${responseText}`
        );
      }

      const data = await response.json();

      console.log("[ASR] Response:", data);

      if (!data.ok) {
        throw new Error(
          data.error || "Handy không trả về transcript."
        );
      }

      const text =
        typeof data.text === "string"
          ? data.text.trim()
          : "";

      if (!text) {
        setError("Handy không nhận diện được giọng nói.");
        setStatus("idle");
        return;
      }

      // Thêm transcript mới vào phía dưới.
      setTranscript((previous) => {
        if (!previous.trim()) {
          return text;
        }

        return `${previous}\n\n${text}`;
      });

      setStatus("idle");
    } catch (err) {
      console.error("[ASR]", err);

      if (err instanceof TypeError) {
        setError(
          "Không thể kết nối Python bridge tại 127.0.0.1:8765."
        );
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Không thể chuyển giọng nói thành văn bản.");
      }

      setStatus("error");
    }
  }, []);

  // ===============================
  // STOP RECORDING
  // ===============================

  const stopRecording = useCallback(
    (shouldTranscribe = true) => {
      if (isStoppingRef.current) {
        return;
      }

      isStoppingRef.current = true;

      const recorder = mediaRecorderRef.current;

      cleanupAudio();

      if (!recorder) {
        cleanupStream();

        if (!shouldTranscribe) {
          setStatus("idle");
        }

        isStoppingRef.current = false;
        return;
      }

      recorder.onstop = async () => {
        cleanupStream();

        const mimeType =
          recorder.mimeType || "audio/webm";

        const blob = new Blob(chunksRef.current, {
          type: mimeType,
        });

        chunksRef.current = [];

        mediaRecorderRef.current = null;

        isStoppingRef.current = false;

        console.log(
          "[Recorder] Finished:",
          mimeType,
          blob.size
        );

        if (!shouldTranscribe || blob.size === 0) {
          setStatus("idle");
          return;
        }

        await transcribe(blob);
      };

      if (recorder.state === "recording") {
        recorder.stop();
      } else {
        cleanupStream();
        setStatus("idle");
        isStoppingRef.current = false;
      }
    },
    [cleanupAudio, cleanupStream, transcribe]
  );

  // ===============================
  // VAD LOOP
  // ===============================

  const runVAD = useCallback(() => {
    const analyser = analyserRef.current;

    if (!analyser) {
      return;
    }

    const data = new Uint8Array(
      analyser.fftSize
    );

    const check = () => {
      if (!analyserRef.current) {
        return;
      }

      analyser.getByteTimeDomainData(data);

      // RMS = Root Mean Square
      let sum = 0;

      for (let i = 0; i < data.length; i++) {
        const normalized =
          (data[i] - 128) / 128;

        sum += normalized * normalized;
      }

      const rms = Math.sqrt(
        sum / data.length
      );

      setVolume(Math.min(rms * 5, 1));

      const now = performance.now();

      // ===========================
      // SPEECH DETECTED
      // ===========================

      if (rms > VAD_THRESHOLD) {
        if (!hasDetectedSpeechRef.current) {
          hasDetectedSpeechRef.current = true;

          speechStartedAtRef.current = now;

          console.log("[VAD] Speech started");

          setStatus("speaking");
        }

        lastSpeechAtRef.current = now;
      }

      // ===========================
      // SILENCE DETECTED
      // ===========================

      if (
        hasDetectedSpeechRef.current &&
        lastSpeechAtRef.current > 0
      ) {
        const silenceDuration =
          now - lastSpeechAtRef.current;

        const recordingDuration =
          now - recordingStartedAtRef.current;

        if (
          silenceDuration >= SILENCE_DURATION &&
          recordingDuration >= MIN_RECORDING_DURATION
        ) {
          console.log(
            "[VAD] Speech ended after",
            silenceDuration,
            "ms silence"
          );

          stopRecording(true);
          return;
        }
      }

      // ===========================
      // WAITING FOR SPEECH TIMEOUT
      // ===========================

      if (
        !hasDetectedSpeechRef.current &&
        now - recordingStartedAtRef.current >
          SPEECH_START_TIMEOUT
      ) {
        console.log(
          "[VAD] No speech detected, stopping."
        );

        stopRecording(false);
        return;
      }

      animationFrameRef.current =
        requestAnimationFrame(check);
    };

    check();
  }, [stopRecording]);

  // ===============================
  // START RECORDING
  // ===============================

  const startRecording = async () => {
    if (
      status === "listening" ||
      status === "speaking" ||
      status === "transcribing"
    ) {
      return;
    }

    try {
      setError("");
      setStatus("listening");

      chunksRef.current = [];

      hasDetectedSpeechRef.current = false;

      speechStartedAtRef.current = null;

      lastSpeechAtRef.current = 0;

      isStoppingRef.current = false;

      // ===========================
      // MICROPHONE
      // ===========================

      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

      streamRef.current = stream;

      // ===========================
      // MEDIA RECORDER
      // ===========================

      let mimeType = "";

      if (
        MediaRecorder.isTypeSupported(
          "audio/webm;codecs=opus"
        )
      ) {
        mimeType = "audio/webm;codecs=opus";
      } else if (
        MediaRecorder.isTypeSupported(
          "audio/webm"
        )
      ) {
        mimeType = "audio/webm";
      } else if (
        MediaRecorder.isTypeSupported(
          "audio/mp4"
        )
      ) {
        mimeType = "audio/mp4";
      }

      const recorder = mimeType
        ? new MediaRecorder(stream, {
            mimeType,
          })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.error(
          "[Recorder] Error:",
          event
        );

        setError(
          "Có lỗi xảy ra khi ghi âm."
        );

        cleanupAll();
        setStatus("error");
      };

      // ===========================
      // AUDIO CONTEXT
      // ===========================

      const AudioContextClass =
        window.AudioContext ||
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;

      if (!AudioContextClass) {
        throw new Error(
          "Browser không hỗ trợ Web Audio API."
        );
      }

      const audioContext =
        new AudioContextClass();

      audioContextRef.current =
        audioContext;

      const source =
        audioContext.createMediaStreamSource(
          stream
        );

      const analyser =
        audioContext.createAnalyser();

      analyser.fftSize = 2048;

      analyser.smoothingTimeConstant = 0.3;

      source.connect(analyser);

      analyserRef.current = analyser;

      // ===========================
      // START
      // ===========================

      recordingStartedAtRef.current =
        performance.now();

      recorder.start(100);

      console.log(
        "[Recorder] Started:",
        recorder.mimeType
      );

      runVAD();
    } catch (err) {
      console.error(
        "[Recorder] Start error:",
        err
      );

      cleanupAll();

      if (
        err instanceof DOMException &&
        err.name === "NotAllowedError"
      ) {
        setError(
          "Bạn chưa cấp quyền microphone cho trình duyệt."
        );
      } else if (
        err instanceof DOMException &&
        err.name === "NotFoundError"
      ) {
        setError(
          "Không tìm thấy microphone."
        );
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(
          "Không thể bắt đầu ghi âm."
        );
      }

      setStatus("error");
    }
  };

  // ===============================
  // MANUAL STOP
  // ===============================

  const handleManualStop = () => {
    if (
      status === "listening" ||
      status === "speaking"
    ) {
      stopRecording(true);
    }
  };

  // ===============================
  // CLEAR
  // ===============================

  const clearTranscript = () => {
    setTranscript("");
    setError("");
  };

  // ===============================
  // PAGE CLEANUP
  // ===============================

  useEffect(() => {
    return () => {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state ===
          "recording"
      ) {
        mediaRecorderRef.current.stop();
      }

      cleanupAll();
    };
  }, [cleanupAll]);

  // ===============================
  // UI STATE
  // ===============================

  const isRecording =
    status === "listening" ||
    status === "speaking";

  const statusText = (() => {
    switch (status) {
      case "listening":
        return "Listening...";

      case "speaking":
        return "Đang nghe...";

      case "transcribing":
        return "Đang chuyển thành văn bản...";

      case "error":
        return "Có lỗi xảy ra";

      default:
        return "Sẵn sàng";
    }
  })();

  const statusDescription = (() => {
    switch (status) {
      case "listening":
        return "Hãy bắt đầu nói";

      case "speaking":
        return "Nói tự nhiên — sẽ tự dừng khi bạn im lặng";

      case "transcribing":
        return "Handy đang xử lý audio local";

      case "error":
        return "Kiểm tra Python bridge và microphone";

      default:
        return "Nhấn microphone để bắt đầu";
    }
  })();

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen max-w-4xl flex-col px-6 py-12">

        {/* =========================
            HEADER
        ========================= */}

        <header className="mb-10">
          <div className="mb-3 text-sm font-medium uppercase tracking-[0.2em] text-white/40">
            VyIQ Speech
          </div>

          <h1 className="text-4xl font-semibold tracking-tight">
            Speech to Text
          </h1>

          <p className="mt-3 max-w-xl text-white/50">
            Nói tự nhiên. Hệ thống sẽ tự phát hiện khi
            bạn nói xong và chuyển giọng nói thành văn bản
            bằng Handy chạy local.
          </p>
        </header>

        {/* =========================
            RECORDER
        ========================= */}

        <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-8">

          <div className="flex flex-col items-center justify-center py-12">

            {/* VOLUME VISUALIZER */}

            <div className="mb-8 flex h-8 items-end justify-center gap-1">
              {Array.from({
                length: 24,
              }).map((_, index) => {
                const distance =
                  Math.abs(
                    index - 12
                  );

                const multiplier =
                  Math.max(
                    0.15,
                    1 - distance / 14
                  );

                const height =
                  isRecording
                    ? Math.max(
                        4,
                        volume *
                          32 *
                          multiplier
                      )
                    : 4;

                return (
                  <div
                    key={index}
                    className="w-1 rounded-full bg-white/60 transition-all duration-75"
                    style={{
                      height: `${height}px`,
                    }}
                  />
                );
              })}
            </div>

            {/* MICROPHONE */}

            <button
              type="button"
              onClick={
                isRecording
                  ? handleManualStop
                  : startRecording
              }
              disabled={
                status === "transcribing"
              }
              className={`
                relative flex h-32 w-32
                items-center justify-center
                rounded-full
                transition-all duration-200
                ${
                  status === "speaking"
                    ? "scale-110 bg-red-500 shadow-[0_0_100px_rgba(239,68,68,0.35)]"
                    : status === "listening"
                    ? "scale-105 bg-red-500/80"
                    : status ===
                      "transcribing"
                    ? "cursor-wait bg-white/10"
                    : "bg-white text-black hover:scale-105 hover:bg-white/90"
                }
              `}
            >
              {status ===
              "transcribing" ? (
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
              ) : isRecording ? (
                <div className="h-8 w-8 rounded-md bg-white" />
              ) : (
                <svg
                  width="36"
                  height="36"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect
                    x="9"
                    y="2"
                    width="6"
                    height="12"
                    rx="3"
                  />

                  <path d="M5 10a7 7 0 0 0 14 0" />

                  <path d="M12 19v3" />

                  <path d="M8 22h8" />
                </svg>
              )}
            </button>

            {/* STATUS */}

            <div className="mt-7 text-center">
              <div
                className={`
                  text-lg font-medium
                  ${
                    status === "speaking"
                      ? "text-red-400"
                      : ""
                  }
                `}
              >
                {statusText}
              </div>

              <div className="mt-1 text-sm text-white/40">
                {statusDescription}
              </div>
            </div>

            {/* MANUAL STOP */}

            {isRecording && (
              <button
                type="button"
                onClick={
                  handleManualStop
                }
                className="mt-6 rounded-full border border-white/10 px-5 py-2 text-sm text-white/60 transition hover:bg-white/5 hover:text-white"
              >
                Stop & Transcribe
              </button>
            )}
          </div>
        </section>

        {/* =========================
            ERROR
        ========================= */}

        {error && (
          <div className="mt-6 rounded-2xl border border-red-500/20 bg-red-500/10 p-4">
            <div className="text-sm font-medium text-red-400">
              Error
            </div>

            <div className="mt-1 text-sm leading-6 text-red-200/70">
              {error}
            </div>
          </div>
        )}

        {/* =========================
            TRANSCRIPT
        ========================= */}

        <section className="mt-8">

          <div className="mb-3 flex items-center justify-between">

            <div>
              <h2 className="text-lg font-medium">
                Transcript
              </h2>

              <p className="mt-1 text-sm text-white/40">
                Kết quả nhận diện từ Handy
              </p>
            </div>

            {transcript && (
              <button
                type="button"
                onClick={
                  clearTranscript
                }
                className="rounded-lg border border-white/10 px-3 py-2 text-sm text-white/50 transition hover:bg-white/5 hover:text-white"
              >
                Clear
              </button>
            )}
          </div>

          <div className="min-h-[240px] rounded-2xl border border-white/10 bg-white/[0.03] p-6">

            {transcript ? (
              <p className="whitespace-pre-wrap text-base leading-8 text-white/90">
                {transcript}
              </p>
            ) : (
              <div className="flex min-h-[190px] items-center justify-center text-sm text-white/25">
                Transcript sẽ xuất hiện ở đây...
              </div>
            )}

          </div>
        </section>

        {/* =========================
            FOOTER
        ========================= */}

        <footer className="mt-8 flex items-center justify-between text-xs text-white/30">

          <span>
            Browser VAD → Python → FFmpeg → Handy
          </span>

          <span className="flex items-center gap-2">
            <span
              className={`
                h-2 w-2 rounded-full
                ${
                  status ===
                    "transcribing"
                    ? "animate-pulse bg-yellow-400"
                    : isRecording
                    ? "animate-pulse bg-red-500"
                    : "bg-green-500"
                }
              `}
            />

            {status ===
            "transcribing"
              ? "Processing"
              : isRecording
              ? "Listening"
              : "Local"}
          </span>

        </footer>
      </div>
    </main>
  );
}

/**
 * Generate filename for recorded audio
 */
function getFileName(
  mimeType: string
) {
  if (mimeType.includes("mp4")) {
    return "recording.mp4";
  }

  if (mimeType.includes("ogg")) {
    return "recording.ogg";
  }

  if (mimeType.includes("wav")) {
    return "recording.wav";
  }

  return "recording.webm";
}