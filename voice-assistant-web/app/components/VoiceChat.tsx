"use client"

import useVoiceAssistant from "../../hooks/useVoiceAssistant"

type VoiceChatProps = {
  unit?: number
}

export default function VoiceChat({ unit }: VoiceChatProps) {
  const {
    state,
    transcript,
    answer,
    isListening,
    isThinking,
    isSpeaking,
    startListening,
    stop,
    availableModels,
    selectedModel,
    selectModel,
    provider,
    selectProvider,
    geminiConfigured,
    isRobotConnected,
    connectRobot,
    disconnectRobot,
  } = useVoiceAssistant(unit)

  const getStatusText = () => {
    switch (state) {
      case "listening":
        return "Listening..."
      case "thinking":
        return "Thinking..."
      case "speaking":
        return "Speaking..."
      default:
        return "Ready"
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-yellow-50 via-orange-50 to-pink-50 flex items-center justify-center p-6">
      <div className="w-full max-w-xl">
        {/* Card */}
        <div className="rounded-3xl border-4 border-yellow-300 bg-white/90 backdrop-blur-xl p-8 shadow-2xl">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="text-sm text-gray-500 mb-2">AI Voice Assistant</div>
            <h1 className="text-3xl font-bold text-gray-800" style={{ fontFamily: 'cursive' }}>
              English Conversation
            </h1>
            <p className="text-gray-600 mt-2">Speak naturally with your AI assistant</p>
          </div>

          <div className="mb-8 space-y-4 text-left">
            <label className="block">
              <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-gray-500">
                AI provider
              </span>
              <select
                value={provider}
                onChange={(event) => selectProvider(event.target.value as "ollama" | "gemini")}
                className="w-full rounded-xl border-2 border-gray-200 bg-white px-4 py-3 text-gray-800 outline-none transition focus:border-[#dc3e1d]"
              >
                <option value="ollama">Local Ollama</option>
                <option value="gemini">Google AI Studio · Gemini 3.8 Flash</option>
              </select>
            </label>

            {provider === "ollama" ? (
              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-gray-500">
                  Local Ollama model
                </span>
                <select
                  value={selectedModel}
                  onChange={(event) => selectModel(event.target.value)}
                  className="w-full rounded-xl border-2 border-gray-200 bg-white px-4 py-3 text-gray-800 outline-none transition focus:border-[#dc3e1d]"
                >
                  {availableModels.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))
                  )}
                </select>
              </label>
            ) : (
              <div
                className={`rounded-xl border-2 px-4 py-3 text-sm ${
                  geminiConfigured === false
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-green-200 bg-green-50 text-green-700"
                }`}
              >
                <span className="font-bold">Gemini 3.8 Flash</span>
                <span className="mt-1 block">
                  {geminiConfigured === false
                    ? "Gemini needs to be configured by the server administrator."
                    : geminiConfigured === true
                      ? "The API key is configured securely on the server."
                      : "Gemini configuration will be checked when you send a message."}
                </span>
              </div>
            )}
          </div>

          {/* Status Indicator */}
          <div className="flex flex-col items-center mb-8">
            <div
              className={`
                w-28 h-28 rounded-full flex items-center justify-center text-4xl transition-all duration-300
                ${
                  isListening
                    ? "bg-blue-500/20 ring-4 ring-blue-500/30 scale-110"
                    : isSpeaking
                    ? "bg-green-500/20 ring-4 ring-green-500/30 scale-110"
                    : isThinking
                    ? "bg-yellow-500/20 ring-4 ring-yellow-500/30"
                    : "bg-gray-100"
                }
              `}
            >
              {isListening ? "🎤" : isSpeaking ? "🔊" : isThinking ? "🧠" : "🤖"}
            </div>
            <div className="mt-4 text-sm text-gray-600 font-medium">{getStatusText()}</div>
          </div>

          {/* User Transcript */}
          <div className="mb-5">
            <div className="text-xs uppercase tracking-wider text-blue-700 mb-2">You</div>
            <div className="min-h-[70px] rounded-2xl bg-blue-50 border-2 border-blue-200 p-4 text-blue-900">
              {transcript || <span className="text-blue-600">Say something...</span>}
            </div>
          </div>

          {/* Assistant Response */}
          <div className="mb-8">
            <div className="text-xs uppercase tracking-wider text-purple-700 mb-2">Assistant</div>
            <div className="min-h-[100px] rounded-2xl bg-purple-50 border-2 border-purple-200 p-4 text-purple-900 leading-relaxed">
              {answer || <span className="text-purple-600">Your assistant&apos;s response will appear here...</span>}
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex justify-center gap-3">
              <button
                onClick={startListening}
                disabled={
                  isListening ||
                  isThinking ||
                  isSpeaking ||
                  (provider === "gemini" && geminiConfigured === false)
                }
                className="px-6 py-3 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 text-white font-bold transition hover:shadow-lg disabled:opacity-40 disabled:cursor-not-allowed"
              >
                🎤 Talk
              </button>
              <button
                onClick={stop}
                className="px-6 py-3 rounded-full bg-gray-100 border-2 border-gray-300 text-gray-700 font-bold transition hover:bg-gray-200"
              >
                Stop
              </button>
            </div>

            {/* Robot connection */}
            <button
              onClick={isRobotConnected ? disconnectRobot : connectRobot}
              className={`px-6 py-3 rounded-full font-bold transition hover:shadow-lg ${
                isRobotConnected
                  ? "bg-green-500 text-white"
                  : "bg-gradient-to-r from-[#1E40AF] to-[#4F46E5] text-white"
              }`}
            >
              {isRobotConnected ? "🤖 Robot connected" : "🤖 Connect robot"}
            </button>
          </div>
        </div>

        {/* Debug state */}
        <div className="text-center mt-4 text-xs text-gray-400">State: {state}</div>
      </div>
    </div>
  )
}
