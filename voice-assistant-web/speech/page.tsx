"use client";

import { useEffect, useRef, useState } from "react";

export default function SpeechToTextPage() {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  /**
   * Start recording
   */
  const startRecording = async () => {
    try {
      setError("");

      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Trình duyệt không hỗ trợ microphone.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;
      chunksRef.current = [];

      // Browser sẽ chọn codec phù hợp
      let mimeType = "";

      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        mimeType = "audio/webm;codecs=opus";
      } else if (MediaRecorder.isTypeSupported("audio/webm")) {
        mimeType = "audio/webm";
      } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
        mimeType = "audio/mp4";
      }

      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const blobType = recorder.mimeType || "audio/webm";

        const audioBlob = new Blob(chunksRef.current, {
          type: blobType,
        });

        // Dừng microphone
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        await transcribe(audioBlob);
      };

      recorder.onerror = () => {
        setError("Có lỗi xảy ra khi ghi âm.");
        setIsRecording(false);

        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      };

      recorder.start();

      setIsRecording(true);
    } catch (err) {
      console.error(err);

      setError(
        "Không thể truy cập microphone. Hãy kiểm tra quyền microphone của trình duyệt."
      );

      setIsRecording(false);
    }
  };

  /**
   * Stop recording
   */
  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;

    if (!recorder) {
      return;
    }

    if (recorder.state === "recording") {
      recorder.stop();
    }

    setIsRecording(false);
  };

  /**
   * Send audio to Python Handy bridge
   */
  const transcribe = async (audioBlob: Blob) => {
    try {
      setError("");
      setIsTranscribing(true);

      const formData = new FormData();

      // Python FastAPI nhận field "file"
      formData.append(
        "file",
        audioBlob,
        getFileName(audioBlob.type)
      );

      // Có thể bỏ field này nếu Python bridge không dùng
      formData.append("language", "vi");

      console.log("Sending audio to Handy bridge...");

      const response = await fetch(
        "http://127.0.0.1:8765/transcribe",
        {
          method: "POST",
          body: formData,
        }
      );

      if (!response.ok) {
        const text = await response.text();

        throw new Error(
          `Transcription server returned ${response.status}: ${text}`
        );
      }

      const data = await response.json();

      console.log("Handy response:", data);

      if (!data.ok) {
        throw new Error(
          data.error || "Không thể chuyển giọng nói thành văn bản."
        );
      }

      // Python bridge hiện tại dự kiến trả:
      // {
      //   ok: true,
      //   text: "..."
      // }

      const text = data.text || "";

      setTranscript((current) => {
        if (!current.trim()) {
          return text;
        }

        return `${current}\n${text}`;
      });
    } catch (err) {
      console.error("[transcribe]", err);

      if (err instanceof TypeError) {
        setError(
          "Không thể kết nối Python bridge. Hãy kiểm tra server tại http://127.0.0.1:8765"
        );
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Không thể chuyển giọng nói thành văn bản.");
      }
    } finally {
      setIsTranscribing(false);
    }
  };

  /**
   * Generate filename based on browser audio format
   */
  const getFileName = (mimeType: string) => {
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
  };

  /**
   * Clear transcript
   */
  const clearTranscript = () => {
    setTranscript("");
    setError("");
  };

  /**
   * Cleanup when leaving page
   */
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }

      streamRef.current?.getTracks().forEach((track) => {
        track.stop();
      });
    };
  }, []);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen max-w-4xl flex-col px-6 py-12">
        {/* Header */}
        <header className="mb-10">
          <div className="mb-3 text-sm font-medium uppercase tracking-[0.2em] text-white/40">
            VyIQ Speech
          </div>

          <h1 className="text-4xl font-semibold tracking-tight">
            Speech to Text
          </h1>

          <p className="mt-3 max-w-xl text-white/50">
            Ghi âm trực tiếp từ microphone và chuyển giọng nói thành văn bản
            bằng Handy chạy local trên máy.
          </p>
        </header>

        {/* Recorder */}
        <section className="rounded-3xl border border-white/10 bg-white/[0.04] p-8">
          <div className="flex flex-col items-center justify-center py-10">
            {/* Recording button */}
            <button
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();

                if (!isRecording && !isTranscribing) {
                  startRecording();
                }
              }}
              onPointerUp={(event) => {
                event.preventDefault();

                if (isRecording) {
                  stopRecording();
                }
              }}
              onPointerLeave={() => {
                if (isRecording) {
                  stopRecording();
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
              }}
              disabled={isTranscribing}
              className={`
                relative flex h-32 w-32
                select-none items-center justify-center
                rounded-full
                transition-all duration-200
                touch-none
                ${
                  isRecording
                    ? "scale-110 bg-red-500 shadow-[0_0_80px_rgba(239,68,68,0.35)]"
                    : isTranscribing
                    ? "cursor-wait bg-white/10"
                    : "bg-white text-black hover:scale-105 hover:bg-white/90"
                }
              `}
            >
              {isRecording ? (
                <div className="h-8 w-8 rounded-md bg-white" />
              ) : isTranscribing ? (
                <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white" />
              ) : (
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
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

            {/* Status */}
            <div className="mt-7 text-center">
              {isRecording ? (
                <>
                  <div className="text-lg font-medium text-red-400">
                    Đang ghi âm
                  </div>

                  <div className="mt-1 text-sm text-white/40">
                    Thả chuột để chuyển thành văn bản
                  </div>
                </>
              ) : isTranscribing ? (
                <>
                  <div className="text-lg font-medium">
                    Đang xử lý...
                  </div>

                  <div className="mt-1 text-sm text-white/40">
                    Handy đang nhận diện giọng nói
                  </div>
                </>
              ) : (
                <>
                  <div className="text-lg font-medium">
                    Nhấn và giữ để nói
                  </div>

                  <div className="mt-1 text-sm text-white/40">
                    Thả chuột để kết thúc
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Error */}
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

        {/* Transcript */}
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-medium">
                Transcript
              </h2>

              <p className="mt-1 text-sm text-white/40">
                Nội dung nhận diện từ Handy
              </p>
            </div>

            {transcript && (
              <button
                type="button"
                onClick={clearTranscript}
                className="rounded-lg border border-white/10 px-3 py-2 text-sm text-white/50 transition hover:bg-white/5 hover:text-white"
              >
                Clear
              </button>
            )}
          </div>

          <div className="min-h-[220px] rounded-2xl border border-white/10 bg-white/[0.03] p-6">
            {transcript ? (
              <p className="whitespace-pre-wrap text-base leading-8 text-white/90">
                {transcript}
              </p>
            ) : (
              <div className="flex min-h-[170px] items-center justify-center text-sm text-white/25">
                Transcript sẽ xuất hiện ở đây...
              </div>
            )}
          </div>
        </section>

        {/* Connection status */}
        <footer className="mt-8 flex items-center justify-between text-xs text-white/30">
          <span>
            Next.js → Python Bridge → Handy
          </span>

          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            Local
          </span>
        </footer>
      </div>
    </main>
  );
}