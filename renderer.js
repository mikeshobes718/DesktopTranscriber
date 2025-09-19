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
const exportTextButton = document.getElementById("exportText");
const exportJsonButton = document.getElementById("exportJson");

const MAX_RECORDING_MS = 180_000;
const LIVE_CHUNK_MS = 1_000;
const LIVE_RETRY_DELAY_MS = 300;
const MAX_KNOWLEDGE_CHARS = 25_000;
const KNOWLEDGE_SNIPPET_LIMIT = 1_200;
const STATUS_RESET_DELAY_MS = 4_000;
let mediaRecorder = null;
let mediaStream = null;
let recordingTimeout = null;
let chunks = [];
let isProcessing = false;
let apiKeyAvailable = false;
let liveTranscriptText = "";
let isStoppingRecord = false;
let lastKnownMimeType = "audio/webm";
let savedTranscripts = [];
let knowledgeBase = "";
const liveChunkQueue = [];
let isProcessingLiveChunk = false;

const API_KEY_STORAGE_KEY = "desktopTranscriber.openaiKey";
const TRANSCRIPTS_STORAGE_KEY = "desktopTranscriber.transcripts";
const KNOWLEDGE_STORAGE_KEY = "desktopTranscriber.knowledge";

function looksLikeQuestion(text) {
  if (!text) return false;
  if (/\?/u.test(text)) {
    return true;
  }

  const normalized = text.toLowerCase();
  const phrases = [
    "tell me about",
    "describe",
    "walk me through",
    "explain",
    "share",
    "talk about",
    "give me an example",
    "give me examples",
    "what would you",
    "how would you",
    "how do you",
    "why did you",
    "why would you",
    "please provide",
    "could you",
    "can you",
    "let me know",
    "i'd like to hear",
    "i would like to hear",
    "tell us",
  ];

  return phrases.some((phrase) => normalized.includes(phrase));
}

function setStatus(message) {
  statusText.textContent = message ?? "";
}

function showTransientStatus(message, duration = STATUS_RESET_DELAY_MS) {
  setStatus(message);
  if (message && duration > 0) {
    window.setTimeout(() => {
      if (statusText.textContent === message) {
        setStatus("");
      }
    }, duration);
  }
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

    const meta = document.createElement("div");
    meta.className = "history__meta";
    meta.appendChild(timestamp);

    if (entry.hasQuestions) {
      const reanswerButton = document.createElement("button");
      reanswerButton.type = "button";
      reanswerButton.className = "history__reanswer";
      reanswerButton.textContent = "Re-answer";
      if (entry.pendingAnswers || !apiKeyAvailable) {
        reanswerButton.disabled = true;
      }
      reanswerButton.addEventListener("click", () => {
        if (!apiKeyAvailable) {
          setKeyStatus("Add your OpenAI API key to generate answers.", "error");
          return;
        }
        const latest = savedTranscripts.find((item) => item.id === entry.id) || entry;
        maybeAnswerQuestions(latest, { force: true });
      });
      meta.appendChild(reanswerButton);
    }

    header.appendChild(title);
    header.appendChild(meta);

    const body = document.createElement("p");
    body.className = "history__text";
    body.textContent = entry.text;

    card.appendChild(header);
    card.appendChild(body);

    if (entry.knowledgeApplied && (entry.knowledgeSnippet || entry.knowledgeFull)) {
      const knowledgeDetails = document.createElement("details");
      knowledgeDetails.className = "history__knowledge";

      const summary = document.createElement("summary");
      const knowledgeLength = Number.isFinite(entry.knowledgeLength)
        ? entry.knowledgeLength
        : entry.knowledgeSnippet.length;
      summary.textContent = `Knowledge base used (${knowledgeLength} chars)`;

      const knowledgeBody = document.createElement("p");
      const knowledgeSource = entry.knowledgeFull || entry.knowledgeSnippet || "";
      const displaySnippet = knowledgeSource.slice(0, KNOWLEDGE_SNIPPET_LIMIT);
      const truncated = entry.knowledgeTruncated || knowledgeSource.length > displaySnippet.length;
      knowledgeBody.textContent = displaySnippet + (truncated ? "…" : "");

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
    } else {
      const status = document.createElement("p");
      status.className = "history__status";
      status.textContent = "No answers generated yet.";
      card.appendChild(status);
    }

    historyContainer.appendChild(card);
  });
}

function addTranscriptEntry(text) {
  const trimmed = text?.trim();
  if (!trimmed) return;

  const knowledgeTrimmed = knowledgeBase?.trim() ?? "";
  const knowledgeSnippet = knowledgeTrimmed.slice(0, KNOWLEDGE_SNIPPET_LIMIT);

  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    text: trimmed,
    title: `Recording ${savedTranscripts.length + 1}`,
    hasQuestions: looksLikeQuestion(trimmed),
    pendingAnswers: false,
    answers: [],
    answerError: null,
    knowledgeApplied: Boolean(knowledgeTrimmed),
    knowledgeSnippet,
    knowledgeLength: knowledgeTrimmed.length,
    knowledgeTruncated: knowledgeTrimmed.length > knowledgeSnippet.length,
    knowledgeFull: knowledgeTrimmed,
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

async function maybeAnswerQuestions(entry, options = {}) {
  const { force = false } = options;
  if (!entry?.id || (!entry.hasQuestions && !force) || !apiKeyAvailable) {
    return;
  }

  const knowledgeTrimmed = knowledgeBase?.trim() ?? "";
  updateTranscriptEntry(entry.id, {
    pendingAnswers: true,
    answerError: null,
    answers: Array.isArray(entry.answers) ? entry.answers : [],
    knowledgeApplied: Boolean(knowledgeTrimmed),
    knowledgeSnippet: knowledgeTrimmed.slice(0, KNOWLEDGE_SNIPPET_LIMIT),
    knowledgeLength: knowledgeTrimmed.length,
    knowledgeTruncated: knowledgeTrimmed.length > KNOWLEDGE_SNIPPET_LIMIT,
    knowledgeFull: knowledgeTrimmed,
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
  liveTranscriptText = "";
  isStoppingRecord = false;
  lastKnownMimeType = "audio/webm";
  liveChunkQueue.length = 0;
  isProcessingLiveChunk = false;
  clearRecordingTimeout();
  setButtons({ recording: false, processing: false });
  isProcessing = false;
  if (clearStatus) {
    setStatus("");
  }
}

function enqueueLiveChunk(blob) {
  if (!blob || !blob.size || isStoppingRecord) {
    return;
  }
  liveChunkQueue.push(blob);
  processLiveChunkQueue();
}

async function processLiveChunkQueue() {
  if (
    isProcessingLiveChunk ||
    !liveChunkQueue.length ||
    isStoppingRecord ||
    !apiKeyAvailable
  ) {
    return;
  }

  const blob = liveChunkQueue.shift();
  if (!blob || !blob.size) {
    return processLiveChunkQueue();
  }

  isProcessingLiveChunk = true;

  try {
    const buffer = await blob.arrayBuffer();
    const result = await window.electronAPI.transcribePartial(buffer, blob.type);

    if (result?.ok) {
      const text = result.text?.trim();
      if (text) {
        liveTranscriptText = liveTranscriptText ? `${liveTranscriptText} ${text}` : text;
        liveTranscriptOutput.textContent = liveTranscriptText;
      }
      if (mediaRecorder?.state === "recording") {
        setStatus("Recording… transcribing live");
      }
      setKeyStatus("API key ready.", "success");
    } else if (result?.error && /api key/i.test(result.error)) {
      apiKeyAvailable = false;
      setKeyStatus("Add a valid API key to continue.", "error");
    }
  } catch (error) {
    showTransientStatus("Live transcription stalled. Retrying…");
  } finally {
    isProcessingLiveChunk = false;
    if (liveChunkQueue.length && !isStoppingRecord) {
      setTimeout(processLiveChunkQueue, LIVE_RETRY_DELAY_MS);
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
        enqueueLiveChunk(event.data);
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
  handleKnowledgeInputChange();
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
      handleKnowledgeInputChange();
      return;
    }
  } catch (error) {
    knowledgeBase = "";
  }

  if (knowledgeInput) {
    knowledgeInput.value = knowledgeBase;
  }
  setKnowledgeStatus("No knowledge base configured.");
  handleKnowledgeInputChange();
}

function downloadFile(filename, data, mimeType) {
  try {
    const blob = new Blob([data], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    window.setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 0);
  } catch (error) {
    showTransientStatus("Unable to export history. Try again.", STATUS_RESET_DELAY_MS);
  }
}

function exportHistoryAsText() {
  if (!savedTranscripts.length) {
    showTransientStatus("No transcripts to export.");
    return;
  }

  const now = new Date();
  const lines = [];
  lines.push(`DesktopTranscriber export — ${now.toLocaleString()}`);
  if (knowledgeBase?.trim()) {
    lines.push("");
    lines.push("Current Knowledge Base:");
    lines.push(knowledgeBase.trim());
  }

  const ordered = [...savedTranscripts].reverse();
  ordered.forEach((entry, index) => {
    lines.push("");
    lines.push("────────────────────────────────────────");
    lines.push(`Recording ${index + 1} — ${formatTimestamp(entry.timestamp)}`);
    lines.push("");
    lines.push(entry.text);

    if (entry.knowledgeApplied && (entry.knowledgeFull || entry.knowledgeSnippet)) {
      lines.push("");
      lines.push("Knowledge used:");
      lines.push((entry.knowledgeFull || entry.knowledgeSnippet || "").trim());
    }

    if (Array.isArray(entry.answers) && entry.answers.length > 0) {
      lines.push("");
      lines.push("Questions & Answers:");
      entry.answers.forEach((qa, qaIndex) => {
        if (!qa) return;
        lines.push(`${qaIndex + 1}. Q: ${qa.question}`);
        lines.push(`   A: ${qa.answer}`);
      });
    }
  });

  const text = lines.join("\n");
  const filename = `desktop-transcriber-${now.toISOString().replace(/[:.]/g, "-")}.txt`;
  downloadFile(filename, text, "text/plain");
  showTransientStatus("History exported as text.");
}

function exportHistoryAsJson() {
  if (!savedTranscripts.length) {
    showTransientStatus("No transcripts to export.");
    return;
  }

  const now = new Date();
  const payload = {
    exportedAt: now.toISOString(),
    knowledgeBase: knowledgeBase ?? "",
    transcripts: savedTranscripts,
  };
  const json = JSON.stringify(payload, null, 2);
  const filename = `desktop-transcriber-${now.toISOString().replace(/[:.]/g, "-")}.json`;
  downloadFile(filename, json, "application/json");
  showTransientStatus("History exported as JSON.");
}

saveKnowledgeButton?.addEventListener("click", handleSaveKnowledge);
clearKnowledgeButton?.addEventListener("click", handleClearKnowledge);
knowledgeInput?.addEventListener("input", handleKnowledgeInputChange);
exportTextButton?.addEventListener("click", exportHistoryAsText);
exportJsonButton?.addEventListener("click", exportHistoryAsJson);

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
              typeof entry?.hasQuestions === "boolean" ? entry.hasQuestions : looksLikeQuestion(text),
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
            knowledgeFull:
              typeof entry?.knowledgeFull === "string"
                ? entry.knowledgeFull.slice(0, MAX_KNOWLEDGE_CHARS)
                : knowledgeSnippet,
          };
        });
      }
    }
  } catch (error) {
    savedTranscripts = [];
  }

  renderHistory();
}
