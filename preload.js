const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  transcribe(buffer, mimeType) {
    return ipcRenderer.invoke("transcribe-audio", { buffer, mimeType });
  },
  transcribePartial(buffer, mimeType) {
    return ipcRenderer.invoke("transcribe-partial", { buffer, mimeType });
  },
  answerQuestions(transcript) {
    return ipcRenderer.invoke("answer-questions", transcript);
  },
  setApiKey(value) {
    return ipcRenderer.invoke("set-api-key", value);
  },
  getApiKeyStatus() {
    return ipcRenderer.invoke("get-api-key-status");
  },
});
