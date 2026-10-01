"use client"

import { useCallback, useEffect, useRef, useState } from "react"

type VoiceState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"

type VoiceProvider = "ollama" | "gemini"
type SpeechRecognitionEventLike = Event & {
  results: {
    length: number
    [index: number]: {
      [index: number]: {
        transcript: string
        confidence?: number
      }
    }
  }
}

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean

  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((event: unknown) => void) | null

  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechRecognitionConstructor =
  new () => SpeechRecognitionLike

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

const API_URL =
  process.env.NEXT_PUBLIC_VOICE_API_URL ||
  "http://127.0.0.1:8000"

export default function useVoiceAssistant(unit?: number) {
  const [state, setState] =
    useState<VoiceState>("idle")

  const [transcript, setTranscript] =
    useState("")

  const [answer, setAnswer] =
    useState("")

  const [availableModels, setAvailableModels] =
    useState<string[]>([])

  const [selectedModel, setSelectedModel] =
    useState("")

  const [provider, setProvider] =
    useState<VoiceProvider>("ollama")

  const [geminiConfigured, setGeminiConfigured] =
    useState<boolean | null>(null)

  const [micError, setMicError] =
    useState<string | null>(null)
  // --------------------------------
  // Refs
  // --------------------------------

  const recognitionRef =
    useRef<SpeechRecognitionLike | null>(null)

  const transcriptRef =
    useRef("")

  const abortControllerRef =
    useRef<AbortController | null>(null)

  const speechQueueRef =
    useRef<string[]>([])

  const speakingRef =
    useRef(false)

  const stoppedRef =
    useRef(false)

  const requestInFlightRef =
    useRef(false)

  const mountedRef =
    useRef(true)

  const listeningTimeoutRef =
    useRef<ReturnType<typeof setTimeout> | null>(null)

  // --------------------------------
  // Robot serial connection
  // --------------------------------
  const portRef = useRef<any>(null)
  const writerRef =
    useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null)
  const [isRobotConnected, setIsRobotConnected] = useState(false)

  const sendSerialCommand = useCallback(async (cmd: string) => {
    if (!writerRef.current) return
    try {
      const encoder = new TextEncoder()
      await writerRef.current.write(encoder.encode(cmd))
    } catch (err) {
      console.error("Failed to send serial command:", err)
    }
  }, [])

  const connectRobot = useCallback(async () => {
    try {
      if (!("serial" in navigator)) {
        alert("Trình duyệt không hỗ trợ Web Serial API")
        return
      }
      const port = await (navigator as any).serial.requestPort()
      await port.open({ baudRate: 9600 })
      portRef.current = port
      writerRef.current = port.writable.getWriter()
      setIsRobotConnected(true)
    } catch (err) {
      console.error("Serial connection failed:", err)
    }
  }, [])

  const disconnectRobot = useCallback(async () => {
    try {
      writerRef.current?.releaseLock()
      writerRef.current = null
      if (portRef.current) {
        await portRef.current.close()
        portRef.current = null
      }
      setIsRobotConnected(false)
    } catch (err) {
      console.error("Serial disconnect failed:", err)
    }
  }, [])

  // Send "1" while speaking, "0" otherwise
  useEffect(() => {
    if (!isRobotConnected) return
    sendSerialCommand(state === "speaking" ? "1" : "0")
  }, [state, isRobotConnected, sendSerialCommand])

  useEffect(() => {
    const savedModel = localStorage.getItem("voiceAssistant_model")
    const savedProvider = localStorage.getItem("voiceAssistant_provider")

    if (savedProvider === "ollama" || savedProvider === "gemini") {
      setProvider(savedProvider)
    }

    fetch(`${API_URL}/models`)
      .then((response) => response.json())
      .then((data: {
        models?: string[]
        default?: string
        gemini_configured?: boolean
      }) => {
        const models = data.models || []
        setAvailableModels(models)
        setGeminiConfigured(data.gemini_configured === true)

        const nextModel = savedModel && models.includes(savedModel)
          ? savedModel
          : data.default || models[0] || ""

        setSelectedModel(nextModel)
      })
      .catch(() => {
        setAvailableModels([])
        setGeminiConfigured(null)
      })
  }, [])

  const selectModel = useCallback((model: string) => {
    setSelectedModel(model)
    localStorage.setItem("voiceAssistant_model", model)
  }, [])

  const selectProvider = useCallback((nextProvider: VoiceProvider) => {
    setProvider(nextProvider)
    localStorage.setItem("voiceAssistant_provider", nextProvider)
  }, [])

  // --------------------------------
  // Clean text for TTS
  // --------------------------------

  const cleanForSpeech = useCallback(
    (text: string) => {
      return text
        // Remove markdown
        .replace(/```[\s\S]*?```/g, "")
        .replace(/[*_#>`~-]/g, "")

        // Remove brackets
        .replace(/[()[\]{}]/g, "")

        // Remove repeated whitespace
        .replace(/\s+/g, " ")

        .trim()
    },
    []
  )

  // --------------------------------
  // Cancel current speech
  // --------------------------------

  const cancelSpeech = useCallback(() => {
    if (typeof window === "undefined") {
      return
    }

    window.speechSynthesis.cancel()

    speechQueueRef.current = []

    speakingRef.current = false
  }, [])

  // --------------------------------
  // Start listening
  // --------------------------------

  const startListening = useCallback(() => {
    if (typeof window === "undefined") {
      return
    }

    if (stoppedRef.current) {
      return
    }

    const Recognition =
      window.SpeechRecognition ||
      window.webkitSpeechRecognition

    if (!Recognition) {
      alert(
        "Speech Recognition is not supported. Please use Chrome."
      )

      return
    }

    console.log("[VOICE] Starting microphone")

    // Cancel old recognition
    try {
      recognitionRef.current?.abort()
    } catch {}

    cancelSpeech()

    transcriptRef.current = ""
    setTranscript("")
    setMicError(null)

    const recognition =
      new Recognition()

    recognition.lang = "en-US"

    recognition.continuous = false

    recognition.interimResults = true

    recognition.onstart = () => {
      console.log("[VOICE] Listening")

      transcriptRef.current = ""

      setTranscript("")

      setState("listening")
    }

    recognition.onresult = (
      event
    ) => {
      let text = ""

      for (
        let i = 0;
        i < event.results.length;
        i++
      ) {
        text +=
          event.results[i][0].transcript
      }

      text = text.trim()

      console.log(
        "[VOICE] Transcript:",
        text
      )

      transcriptRef.current = text

      setTranscript(text)
    }

    recognition.onerror = (
      event
    ) => {
      console.error(
        "[VOICE] Recognition error:",
        event
      )

      const err = event as { error?: string }
      setMicError(
        err?.error === "not-allowed" || err?.error === "service-not-allowed"
          ? "Microphone bị chặn. Kiểm tra quyền mic và thiết bị thu âm mặc định (robot USB có thể chiếm mic)."
          : err?.error === "audio-capture"
            ? "Không thể truy cập microphone. Robot USB có thể đang chiếm thiết bị thu âm."
            : `Lỗi microphone: ${err?.error || "unknown"}`
      )

      setState("idle")
    }

    recognition.onend = () => {
      const text =
        transcriptRef.current.trim()

      console.log(
        "[VOICE] Recognition ended:",
        text
      )

      if (stoppedRef.current) {
        return
      }

      if (!text) {
        setState("idle")
        return
      }

      sendMessage(text)
    }

    recognitionRef.current =
      recognition

    try {
      recognition.start()
    } catch (error) {
      console.error(
        "[VOICE] Recognition start failed:",
        error
      )

      setState("idle")
    }
  }, [cancelSpeech])

  // --------------------------------
  // TTS queue
  // --------------------------------

  const speakNext = useCallback(() => {
    if (
      typeof window === "undefined"
    ) {
      return
    }

    if (speakingRef.current) {
      return
    }

    const next =
      speechQueueRef.current.shift()

    // Nothing left
    if (!next) {
      console.log(
        "[TTS] Queue empty"
      )

      if (requestInFlightRef.current) {
        setState("thinking")
        return
      }

      setState("idle")

      if (
        !stoppedRef.current
      ) {
        if (
          listeningTimeoutRef.current
        ) {
          clearTimeout(
            listeningTimeoutRef.current
          )
        }

        listeningTimeoutRef.current =
          setTimeout(() => {
            if (
              !stoppedRef.current &&
              mountedRef.current
            ) {
              startListening()
            }
          }, 300)
      }

      return
    }

    const text =
      cleanForSpeech(next)

    if (!text) {
      speakNext()
      return
    }

    console.log(
      "[TTS] Speaking:",
      text
    )

    speakingRef.current = true

    setState("speaking")

    const utterance =
      new SpeechSynthesisUtterance(
        text
      )

    utterance.lang = "en-US"

    utterance.rate = 1.0

    utterance.pitch = 1.0

    utterance.volume = 1.0

    utterance.onstart = () => {
      console.log(
        "[TTS] Started"
      )

      setState("speaking")
    }

    utterance.onend = () => {
      console.log(
        "[TTS] Finished"
      )

      speakingRef.current = false

      // Immediately speak next sentence
      speakNext()
    }

    utterance.onerror = (
      event
    ) => {
      console.error(
        "[TTS] Error:",
        event
      )

      speakingRef.current = false

      speakNext()
    }

    window.speechSynthesis.speak(
      utterance
    )
  }, [
    cleanForSpeech,
    startListening,
  ])

  // --------------------------------
  // Add sentence to TTS queue
  // --------------------------------

  const enqueueSpeech =
    useCallback(
      (text: string) => {
        const clean =
          cleanForSpeech(text)

        if (!clean) {
          return
        }

        console.log(
          "[TTS] Queue:",
          clean
        )

        speechQueueRef.current.push(
          clean
        )

        // If TTS is idle, start immediately
        if (
          !speakingRef.current
        ) {
          speakNext()
        }
      },
      [
        cleanForSpeech,
        speakNext,
      ]
    )

  // --------------------------------
  // Send message
  // --------------------------------

  const sendMessage =
    useCallback(
      async (text: string) => {
        const message =
          text.trim()

        if (!message) {
          return
        }

        console.log(
          "[VOICE] Sending:",
          message
        )

        setState("thinking")

        setAnswer("")

        cancelSpeech()

        requestInFlightRef.current = true

        let streamCompleted = false

        const controller =
          new AbortController()

        abortControllerRef.current =
          controller

        try {
          const url =
            `${API_URL}/chat/stream`

          console.log(
            "[VOICE] POST:",
            url
          )

          const response =
            await fetch(url, {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",
                Accept:
                  "text/plain",
              },

              body: JSON.stringify({
                message,

                provider,

                unit,

                model: provider === "gemini"
                  ? "gemini-3.8-flash"
                  : selectedModel || undefined,

                temperature: 0.2,

                max_tokens: 256,
              }),

              signal:
                controller.signal,
            })

          console.log(
            "[VOICE] HTTP:",
            response.status
          )

          if (!response.ok) {
            const errorText =
              await response.text()

            let errorMessage =
              "The assistant request failed."

            try {
              const errorData = JSON.parse(errorText) as {
                detail?: string
              }

              if (errorData.detail) {
                errorMessage = errorData.detail
              }
            } catch {
              if (errorText) {
                errorMessage = errorText
              }
            }

            throw new Error(
              errorMessage
            )
          }

          if (!response.body) {
            throw new Error("The assistant returned an empty response.")
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let fullText = ""
          let sentenceBuffer = ""

          while (true) {
            const { done, value } = await reader.read()

            if (done) {
              break
            }

            const chunk = decoder.decode(value, { stream: true })
            fullText += chunk
            sentenceBuffer += chunk
            setAnswer(fullText)

            const sentenceRegex = /(.+?[.!?](?:\s+|$))/g
            let match
            let lastIndex = 0

            while ((match = sentenceRegex.exec(sentenceBuffer)) !== null) {
              const sentence = match[1].trim()

              if (sentence) {
                enqueueSpeech(sentence)
              }

              lastIndex = sentenceRegex.lastIndex
            }

            sentenceBuffer = sentenceBuffer.slice(lastIndex)
          }

          const finalChunk = decoder.decode()

          if (finalChunk) {
            fullText += finalChunk
            sentenceBuffer += finalChunk
            setAnswer(fullText)
          }

          if (sentenceBuffer.trim()) {
            enqueueSpeech(sentenceBuffer.trim())
          }

          streamCompleted = true

          console.log(
            "[VOICE] Chat complete:",
            fullText
          )

        } catch (error) {
          if (
            error instanceof Error &&
            error.name ===
              "AbortError"
          ) {
            console.log(
              "[VOICE] Request aborted"
            )

            return
          }

          console.error(
            "[VOICE] Request failed:",
            error
          )

          setAnswer(
            error instanceof Error
              ? error.message
              : "Sorry, I could not connect to the assistant."
          )

          setState("idle")
        } finally {
          requestInFlightRef.current = false

          abortControllerRef.current =
            null

          if (
            streamCompleted &&
            !speakingRef.current &&
            speechQueueRef.current.length === 0
          ) {
            speakNext()
          }
        }
      },
      [
        cancelSpeech,
        enqueueSpeech,
        provider,
        selectedModel,
        speakNext,
        unit,
      ]
    )

  // --------------------------------
  // Stop everything
  // --------------------------------

  const stop =
    useCallback(() => {
      console.log(
        "[VOICE] STOP"
      )

      stoppedRef.current =
        true

      try {
        recognitionRef.current?.abort()
      } catch {}

      try {
        abortControllerRef.current?.abort()
      } catch {}

      cancelSpeech()

      if (
        listeningTimeoutRef.current
      ) {
        clearTimeout(
          listeningTimeoutRef.current
        )
      }

      setState("idle")
    }, [cancelSpeech])

  // --------------------------------
  // Cleanup
  // --------------------------------

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false

      try {
        recognitionRef.current?.abort()
      } catch {}

      try {
        abortControllerRef.current?.abort()
      } catch {}

      if (
        listeningTimeoutRef.current
      ) {
        clearTimeout(
          listeningTimeoutRef.current
        )
      }

      if (
        typeof window !==
        "undefined"
      ) {
        window.speechSynthesis.cancel()
      }

      speechQueueRef.current = []

      speakingRef.current = false
    }
  }, [])

  // --------------------------------
  // Public API
  // --------------------------------

  return {
    state,

    transcript,

    answer,

    isListening:
      state === "listening",

    isThinking:
      state === "thinking",

    isSpeaking:
      state === "speaking",

    startListening,

    availableModels,

    geminiConfigured,
    provider,
    selectProvider,
    selectedModel,

    selectModel,

    sendMessage,

    stop,

    isRobotConnected,
    connectRobot,
    disconnectRobot,

    micError,
  }
}
