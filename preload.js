const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  transcribe(buffer, mimeType) {
    return ipcRenderer.invoke("transcribe-audio", { buffer, mimeType });
  },
  transcribePartial(buffer, mimeType) {
    return ipcRenderer.invoke("transcribe-partial", { buffer, mimeType });
  },
  answerQuestions(payload) {
    return ipcRenderer.invoke("answer-questions", payload);
  },
  startRealtime() {
    return ipcRenderer.invoke("realtime-start");
  },
  sendRealtimeChunk(buffer, mimeType) {
    return ipcRenderer.invoke("realtime-send-chunk", { buffer, mimeType });
  },
  stopRealtime() {
    return ipcRenderer.invoke("realtime-stop");
  },
  onRealtimeTranscript(callback) {
    ipcRenderer.on("realtime-transcript-update", (_event, payload) => {
      callback?.(payload);
    });
  },
  onRealtimeError(callback) {
    ipcRenderer.on("realtime-transcript-error", (_event, payload) => {
      callback?.(payload);
    });
  },
  setApiKey(value) {
    return ipcRenderer.invoke("set-api-key", value);
  },
  getApiKeyStatus() {
    return ipcRenderer.invoke("get-api-key-status");
  },
});
