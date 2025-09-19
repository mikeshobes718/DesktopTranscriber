const listenButton = document.getElementById("listen");
const stopButton = document.getElementById("stop");
const resetButton = document.getElementById("reset");
const statusText = document.getElementById("status");
const liveTranscriptOutput = document.getElementById("liveTranscriptOutput");
const historyContainer = document.getElementById("transcriptHistory");
const clearHistoryButton = document.getElementById("clearHistory");
const apiKeyInput = document.getElementById("apiKeyInput");
const saveKeyButton = document.getElementById("saveKey");
const clearKeyButton = document.getElementById("clearKey");
const keyStatusText = document.getElementById("keyStatus");
const knowledgeInput = document.getElementById("knowledgeInput");
const saveKnowledgeButton = document.getElementById("saveKnowledge");
const clearKnowledgeButton = document.getElementById("clearKnowledge");
const knowledgeStatusText = document.getElementById("knowledgeStatus");

const MAX_RECORDING_MS = 180_000;
const LIVE_CHUNK_MS = 3_000;
const LIVE_RETRY_DELAY_MS = 600;
const MAX_KNOWLEDGE_CHARS = 5_000;
let mediaRecorder = null;
let mediaStream = null;
let recordingTimeout = null;
let chunks = [];
let isProcessing = false;
let apiKeyAvailable = false;
let isLiveTranscribing = false;
let liveTranscriptionQueued = false;
let liveTranscriptText = "";
let isStoppingRecord = false;
let lastKnownMimeType = "audio/webm";
let savedTranscripts = [];
let knowledgeBase = "";

const API_KEY_STORAGE_KEY = "desktopTranscriber.openaiKey";
const TRANSCRIPTS_STORAGE_KEY = "desktopTranscriber.transcripts";
const KNOWLEDGE_STORAGE_KEY = "desktopTranscriber.knowledge";

function setStatus(message) {
  statusText.textContent = message ?? "";
}

function setKeyStatus(message, tone = "info") {
  if (!keyStatusText) return;
  keyStatusText.textContent = message ?? "";
  if (tone === "error") {
    keyStatusText.style.color = "#dc2626";
  } else if (tone === "success") {
    keyStatusText.style.color = "#16a34a";
  } else {
    keyStatusText.style.color = "#1d4ed8";
  }
}

function setKnowledgeStatus(message, tone = "info") {
  if (!knowledgeStatusText) return;
  knowledgeStatusText.textContent = message ?? "";
  if (tone === "error") {
    knowledgeStatusText.style.color = "#dc2626";
  } else if (tone === "success") {
    knowledgeStatusText.style.color = "#16a34a";
  } else {
    knowledgeStatusText.style.color = "#1d4ed8";
  }
}

function setButtons({ recording, processing }) {
  listenButton.disabled = recording || processing;
  stopButton.disabled = !recording;
  resetButton.disabled = recording || processing;
}

function clearRecordingTimeout() {
  if (recordingTimeout) {
    clearTimeout(recordingTimeout);
    recordingTimeout = null;
  }
}

function formatTimestamp(isoString) {
  try {
    const date = isoString ? new Date(isoString) : new Date();
    if (Number.isNaN(date.getTime())) {
      return new Date().toLocaleString();
    }
    return date.toLocaleString();
  } catch (error) {
    return new Date().toLocaleString();
  }
}

function persistTranscripts() {
  try {
    const trimmed = savedTranscripts.slice(0, 100);
    localStorage.setItem(TRANSCRIPTS_STORAGE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    // Ignore serialization issues; user history simply won't persist this session.
  }
}

function renderHistory() {
  if (!historyContainer) return;

  historyContainer.innerHTML = "";

  if (!savedTranscripts.length) {
    const empty = document.createElement("p");
    empty.className = "history__empty";
    empty.textContent = "No transcripts saved yet.";
    historyContainer.appendChild(empty);
    clearHistoryButton?.setAttribute("disabled", "true");
    return;
  }

  clearHistoryButton?.removeAttribute("disabled");

  savedTranscripts.forEach((entry, index) => {
    const card = document.createElement("article");
    card.className = "history__item";

    const header = document.createElement("div");
    header.className = "history__item-header";

    const title = document.createElement("span");
    title.textContent = entry.title || `Recording ${savedTranscripts.length - index}`;

    const timestamp = document.createElement("span");
    timestamp.className = "history__timestamp";
    timestamp.textContent = formatTimestamp(entry.timestamp);

    header.appendChild(title);
    header.appendChild(timestamp);

    const body = document.createElement("p");
    body.className = "history__text";
    body.textContent = entry.text;

    card.appendChild(header);
    card.appendChild(body);

    if (entry.knowledgeApplied && entry.knowledgeSnippet) {
      const knowledgeDetails = document.createElement("details");
      knowledgeDetails.className = "history__knowledge";

      const summary = document.createElement("summary");
      const knowledgeLength = Number.isFinite(entry.knowledgeLength)
        ? entry.knowledgeLength
        : entry.knowledgeSnippet.length;
      summary.textContent = `Knowledge base used (${knowledgeLength} chars)`;

      const knowledgeBody = document.createElement("p");
      knowledgeBody.textContent = entry.knowledgeSnippet + (entry.knowledgeTruncated ? "…" : "");

      knowledgeDetails.appendChild(summary);
      knowledgeDetails.appendChild(knowledgeBody);
      card.appendChild(knowledgeDetails);
    } else if (entry.knowledgeApplied) {
      const badge = document.createElement("p");
      badge.className = "history__status";
      badge.textContent = "Knowledge base applied.";
      card.appendChild(badge);
    }

    if (entry.pendingAnswers) {
      const status = document.createElement("p");
      status.className = "history__status";
      status.textContent = "Generating answers to detected questions…";
      card.appendChild(status);
    } else if (entry.answerError) {
      const status = document.createElement("p");
      status.className = "history__status history__status--error";
      status.textContent = entry.answerError;
      card.appendChild(status);
    } else if (Array.isArray(entry.answers) && entry.answers.length > 0) {
      const answersBlock = document.createElement("div");
      answersBlock.className = "history__answers";

      entry.answers.forEach((qa) => {
        if (!qa) return;
        const question = typeof qa.question === "string" ? qa.question.trim() : "";
        const answer = typeof qa.answer === "string" ? qa.answer.trim() : "";
        if (!question || !answer) return;

        const qaItem = document.createElement("div");
        qaItem.className = "history__qa";

        const qLabel = document.createElement("p");
        qLabel.className = "history__question";
        qLabel.textContent = question;

        const aLabel = document.createElement("p");
        aLabel.className = "history__answer";
        aLabel.textContent = answer;

        qaItem.appendChild(qLabel);
        qaItem.appendChild(aLabel);
        answersBlock.appendChild(qaItem);
      });

      if (answersBlock.childElementCount > 0) {
        card.appendChild(answersBlock);
      }
    }

    historyContainer.appendChild(card);
  });
}

function addTranscriptEntry(text) {
  const trimmed = text?.trim();
  if (!trimmed) return;

  const knowledgeTrimmed = knowledgeBase?.trim() ?? "";
  const knowledgeSnippetLimit = 1_200;
  const knowledgeSnippet = knowledgeTrimmed.slice(0, knowledgeSnippetLimit);

  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    text: trimmed,
    title: `Recording ${savedTranscripts.length + 1}`,
    hasQuestions: /\?/.test(trimmed),
    pendingAnswers: false,
    answers: [],
    answerError: null,
    knowledgeApplied: Boolean(knowledgeTrimmed),
    knowledgeSnippet,
    knowledgeLength: knowledgeTrimmed.length,
    knowledgeTruncated: knowledgeTrimmed.length > knowledgeSnippet.length,
  };

  savedTranscripts.unshift(entry);

  if (savedTranscripts.length > 100) {
    savedTranscripts.length = 100;
  }

  persistTranscripts();
  renderHistory();

  return entry;
}

function clearTranscriptHistory() {
  savedTranscripts = [];
  persistTranscripts();
  renderHistory();
}

function updateTranscriptEntry(id, updates) {
  if (!id) return null;
  const index = savedTranscripts.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return null;
  }

  const current = savedTranscripts[index];
  const next = {
    ...current,
    ...updates,
  };

  savedTranscripts[index] = next;
  persistTranscripts();
  renderHistory();
  return next;
}

async function maybeAnswerQuestions(entry) {
  if (!entry?.id || !entry.hasQuestions || !apiKeyAvailable) {
    return;
  }

  updateTranscriptEntry(entry.id, {
    pendingAnswers: true,
    answerError: null,
    answers: Array.isArray(entry.answers) ? entry.answers : [],
  });

  try {
    const knowledgeTrimmed = knowledgeBase?.trim() ?? "";
    const result = await window.electronAPI.answerQuestions({
      transcript: entry.text,
      knowledge: knowledgeTrimmed,
    });
    if (result?.ok) {
      const answers = Array.isArray(result.answers) ? result.answers : [];
      updateTranscriptEntry(entry.id, {
        pendingAnswers: false,
        answers,
      });
    } else {
      const message = result?.error || "Unable to generate answers.";
      updateTranscriptEntry(entry.id, {
        pendingAnswers: false,
        answerError: message,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to generate answers.";
    updateTranscriptEntry(entry.id, {
      pendingAnswers: false,
      answerError: message,
    });
  }
}

function resetState(options = {}) {
  const { clearStatus = true } = options;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }

  mediaRecorder = null;
  mediaStream = null;
  chunks = [];
  liveTranscriptionQueued = false;
  isLiveTranscribing = false;
  liveTranscriptText = "";
  isStoppingRecord = false;
  lastKnownMimeType = "audio/webm";
  clearRecordingTimeout();
  setButtons({ recording: false, processing: false });
  isProcessing = false;
  if (clearStatus) {
    setStatus("");
  }
}

async function requestLiveTranscription() {
  if (isProcessing || isStoppingRecord || !apiKeyAvailable) {
    return;
  }
  if (!chunks.length) {
    return;
  }
  if (isLiveTranscribing) {
    liveTranscriptionQueued = true;
    return;
  }

  isLiveTranscribing = true;
  try {
    const audioBlob = new Blob(chunks, { type: lastKnownMimeType });
    const buffer = await audioBlob.arrayBuffer();
    const result = await window.electronAPI.transcribePartial(buffer, audioBlob.type);

    if (result?.ok) {
      liveTranscriptText = result.text?.trim() || "";
      if (mediaRecorder?.state === "recording") {
        liveTranscriptOutput.textContent = liveTranscriptText || "Listening…";
        setStatus("Recording… transcribing live");
      }
      if (liveTranscriptText) {
        setKeyStatus("API key ready.", "success");
      }
    } else if (result?.error) {
      if (/api key/i.test(result.error)) {
        apiKeyAvailable = false;
        setKeyStatus("Add a valid API key to continue.", "error");
      }
    }
  } catch (error) {
    // Swallow live errors to avoid spamming the UI; final transcription will surface issues.
  } finally {
    isLiveTranscribing = false;
    if (liveTranscriptionQueued && !isStoppingRecord) {
      liveTranscriptionQueued = false;
      setTimeout(() => {
        requestLiveTranscription();
      }, LIVE_RETRY_DELAY_MS);
    }
  }
}

async function sendForTranscription(audioBlob) {
  try {
    isProcessing = true;
    setButtons({ recording: false, processing: true });
    setStatus("Processing transcription…");
    liveTranscriptOutput.textContent = "Waiting for transcription…";

    const buffer = await audioBlob.arrayBuffer();
    const result = await window.electronAPI.transcribe(buffer, audioBlob.type);

    if (result?.ok) {
      liveTranscriptOutput.textContent = result.text?.trim() || "No speech detected.";
      setStatus("Transcription complete.");
      liveTranscriptText = liveTranscriptOutput.textContent;
      setKeyStatus("API key ready.", "success");
      const entry = addTranscriptEntry(liveTranscriptText);
      maybeAnswerQuestions(entry);
    } else {
      const errorMessage = result?.error || "Transcription failed.";
      liveTranscriptOutput.textContent = errorMessage;
      setStatus("Transcription failed.");
      if (typeof errorMessage === "string" && /api key/i.test(errorMessage)) {
        apiKeyAvailable = false;
        setKeyStatus("Add a valid API key to continue.", "error");
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    liveTranscriptOutput.textContent = message;
    setStatus("Transcription failed.");
  } finally {
    isProcessing = false;
    setButtons({ recording: false, processing: false });
  }
}

async function startRecording() {
  if (isProcessing) return;

  if (!apiKeyAvailable) {
    liveTranscriptOutput.textContent = "Add your OpenAI API key in the section above before recording.";
    setStatus("Waiting for API key.");
    setKeyStatus("Add a valid API key to start transcribing.", "error");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    liveTranscriptOutput.textContent = "Your system does not support microphone capture.";
    return;
  }

  try {
    liveTranscriptOutput.textContent = "";
    setStatus("Requesting microphone access…");
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    mediaRecorder = new MediaRecorder(mediaStream);
    chunks = [];
    liveTranscriptText = "";
    isStoppingRecord = false;
    lastKnownMimeType = "audio/webm";
    liveTranscriptOutput.textContent = "Listening…";

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
        if (event.data.type) {
          lastKnownMimeType = event.data.type;
        }
        if (!isStoppingRecord) {
          requestLiveTranscription();
        }
      }
    });

    mediaRecorder.addEventListener("stop", async () => {
      if (!chunks.length) {
        setStatus("No audio captured.");
        setButtons({ recording: false, processing: false });
        return;
      }

      const audioBlob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
      await sendForTranscription(audioBlob);
      resetState({ clearStatus: false });
    });

    mediaRecorder.start(LIVE_CHUNK_MS);
    setButtons({ recording: true, processing: false });
    setStatus("Recording… transcribing live");

    recordingTimeout = setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
    }, MAX_RECORDING_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to access microphone.";
    liveTranscriptOutput.textContent = message;
    resetState();
  }
}

function stopRecording() {
  if (!mediaRecorder) return;
  isStoppingRecord = true;
  if (mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    setButtons({ recording: false, processing: true });
    clearRecordingTimeout();
  }
}

function resetTranscript() {
  resetState();
  liveTranscriptOutput.textContent = "Your transcript will appear here.";
}

listenButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
resetButton.addEventListener("click", resetTranscript);

window.addEventListener("beforeunload", () => {
  resetState();
});

async function initializeApiKey() {
  try {
    const storedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (storedKey && apiKeyInput) {
      apiKeyInput.value = storedKey;
      const result = await window.electronAPI?.setApiKey(storedKey);
      apiKeyAvailable = Boolean(result?.ok && !result?.cleared);
      if (apiKeyAvailable) {
        setKeyStatus("API key loaded from local storage.", "success");
        return;
      }
    }

    const status = await window.electronAPI?.getApiKeyStatus();
    apiKeyAvailable = Boolean(status?.hasKey);
    if (apiKeyAvailable) {
      setKeyStatus("Using API key provided via environment variables.");
    } else {
      setKeyStatus("No API key configured yet.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to initialize API key.";
    setKeyStatus(message, "error");
  }
}

async function handleSaveKey() {
  const rawKey = apiKeyInput?.value?.trim();
  if (!rawKey) {
    setKeyStatus("Enter a valid API key before saving.", "error");
    return;
  }

  try {
    const result = await window.electronAPI?.setApiKey(rawKey);
    if (result?.ok) {
      localStorage.setItem(API_KEY_STORAGE_KEY, rawKey);
      apiKeyAvailable = true;
      setKeyStatus("API key saved locally.", "success");
    } else {
      apiKeyAvailable = false;
      const message = result?.message || "Unable to save API key.";
      setKeyStatus(message, "error");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save API key.";
    apiKeyAvailable = false;
    setKeyStatus(message, "error");
  }
}

async function handleClearKey() {
  try {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    if (apiKeyInput) {
      apiKeyInput.value = "";
    }
    await window.electronAPI?.setApiKey("");
    apiKeyAvailable = false;
    setKeyStatus("API key cleared. Add a new key to transcribe.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to clear API key.";
    setKeyStatus(message, "error");
  }
}

saveKeyButton?.addEventListener("click", handleSaveKey);
clearKeyButton?.addEventListener("click", handleClearKey);
clearHistoryButton?.addEventListener("click", clearTranscriptHistory);

function handleKnowledgeInputChange() {
  if (!knowledgeInput) return;
  const currentLength = knowledgeInput.value.length;
  if (currentLength > MAX_KNOWLEDGE_CHARS) {
    setKnowledgeStatus(
      `Knowledge base is ${currentLength.toLocaleString()} characters — reduce to ${MAX_KNOWLEDGE_CHARS.toLocaleString()}.`,
      "error"
    );
  } else {
    setKnowledgeStatus(
      `${currentLength.toLocaleString()} / ${MAX_KNOWLEDGE_CHARS.toLocaleString()} characters entered.`,
      "info"
    );
  }
}

function handleClearKnowledge() {
  knowledgeBase = "";
  localStorage.removeItem(KNOWLEDGE_STORAGE_KEY);
  if (knowledgeInput) {
    knowledgeInput.value = "";
  }
  setKnowledgeStatus("Knowledge cleared. Add new context when needed.");
}

function handleSaveKnowledge() {
  if (!knowledgeInput) return;
  const raw = knowledgeInput.value ?? "";
  const trimmed = raw.trim();

  if (!trimmed) {
    handleClearKnowledge();
    return;
  }

  if (trimmed.length > MAX_KNOWLEDGE_CHARS) {
    setKnowledgeStatus(
      `Too long to save (${trimmed.length.toLocaleString()} chars). Limit is ${MAX_KNOWLEDGE_CHARS.toLocaleString()}.`,
      "error"
    );
    return;
  }

  knowledgeBase = trimmed;
  localStorage.setItem(KNOWLEDGE_STORAGE_KEY, knowledgeBase);
  setKnowledgeStatus(`Knowledge saved (${knowledgeBase.length.toLocaleString()} chars).`, "success");
}

function initializeKnowledge() {
  try {
    const stored = localStorage.getItem(KNOWLEDGE_STORAGE_KEY);
    if (stored) {
      const trimmed = stored.trim();
      knowledgeBase = trimmed.slice(0, MAX_KNOWLEDGE_CHARS);
      if (knowledgeInput) {
        knowledgeInput.value = knowledgeBase;
      }
      if (stored.length > MAX_KNOWLEDGE_CHARS) {
        localStorage.setItem(KNOWLEDGE_STORAGE_KEY, knowledgeBase);
      }
      setKnowledgeStatus(`Knowledge loaded (${knowledgeBase.length.toLocaleString()} chars).`, "success");
      return;
    }
  } catch (error) {
    knowledgeBase = "";
  }

  if (knowledgeInput) {
    knowledgeInput.value = knowledgeBase;
  }
  setKnowledgeStatus("No knowledge base configured.");
}

saveKnowledgeButton?.addEventListener("click", handleSaveKnowledge);
clearKnowledgeButton?.addEventListener("click", handleClearKnowledge);
knowledgeInput?.addEventListener("input", handleKnowledgeInputChange);

initializeApiKey();
initializeKnowledge();
initializeTranscripts();

function initializeTranscripts() {
  try {
    const stored = localStorage.getItem(TRANSCRIPTS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        savedTranscripts = parsed.map((entry, index) => {
          const text = typeof entry?.text === "string" ? entry.text : "";
          const knowledgeSnippet = typeof entry?.knowledgeSnippet === "string" ? entry.knowledgeSnippet : "";
          const knowledgeLength = Number.isFinite(entry?.knowledgeLength)
            ? entry.knowledgeLength
            : knowledgeSnippet.length;
          return {
            id: entry?.id || `${Date.now()}-${index}`,
            timestamp: entry?.timestamp || new Date().toISOString(),
            text,
            title: entry?.title || `Recording ${parsed.length - index}`,
            hasQuestions:
              typeof entry?.hasQuestions === "boolean" ? entry.hasQuestions : /\?/.test(text),
            pendingAnswers: Boolean(entry?.pendingAnswers),
            answers: Array.isArray(entry?.answers) ? entry.answers : [],
            answerError: typeof entry?.answerError === "string" ? entry.answerError : null,
            knowledgeApplied:
              typeof entry?.knowledgeApplied === "boolean"
                ? entry.knowledgeApplied
                : Boolean(knowledgeSnippet || knowledgeLength),
            knowledgeSnippet,
            knowledgeLength,
            knowledgeTruncated:
              typeof entry?.knowledgeTruncated === "boolean"
                ? entry.knowledgeTruncated
                : knowledgeLength > knowledgeSnippet.length,
          };
        });
      }
    }
  } catch (error) {
    savedTranscripts = [];
  }

  renderHistory();
}
