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
  setApiKey(value) {
    return ipcRenderer.invoke("set-api-key", value);
  },
  getApiKeyStatus() {
    return ipcRenderer.invoke("get-api-key-status");
  },
});
