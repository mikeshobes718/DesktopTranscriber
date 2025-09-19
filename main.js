const electron = require("electron");

if (!electron || typeof electron !== "object" || !electron.app) {
  throw new Error(
    "Electron runtime not detected. Launch the app with the Electron executable (npm start or packaged app)."
  );
}

const { app, BrowserWindow, ipcMain, dialog } = electron;
const path = require("path");
const OpenAI = require("openai");

const WINDOWS = new Set();

let openAIClient = null;
let openAIKey = process.env.OPENAI_API_KEY?.trim() || "";

function toNodeBuffer(data) {
  if (!data) {
    throw new Error("Empty audio payload received.");
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer);
  }
  throw new Error("Unsupported audio payload format.");
}

function getClient() {
  if (!openAIKey) {
    throw new Error("OpenAI API key not configured. Add it in the application settings.");
  }
  if (!openAIClient) {
    openAIClient = new OpenAI({ apiKey: openAIKey });
  }
  return openAIClient;
}

async function transcribePayload({ buffer, mimeType }) {
  const client = getClient();
  const nodeBuffer = toNodeBuffer(buffer);
  const file = await OpenAI.toFile(nodeBuffer, "recording.webm", {
    type: mimeType || "audio/webm",
  });

  return client.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file,
    language: "en",
    response_format: "text",
  });
}

async function answerQuestionsFromTranscript(transcript, knowledgeBase = "") {
  const client = getClient();
  const systemPrompt =
    "You are an assistant that extracts interview prompts from a transcript and answers them accurately. " +
    "Prompts may be phrased as questions or statements (for example, 'Tell me about your experience'). " +
    "Use any provided knowledge base when answering and note when the knowledge base was used. " +
    "If the knowledge base does not contain the requested information, provide a concise answer from your own knowledge and mention that the answer came from general knowledge. " +
    "Respond strictly as JSON with the shape {\"answers\":[{\"question\":string,\"answer\":string,\"source\":\"knowledge_base\"|\"general\"}]}. " +
    "If there are no prompts that require answers, respond with {\"answers\":[]}.";

  const cleanedKnowledge = knowledgeBase ? knowledgeBase.slice(0, 25_000) : "";
  const sections = [];
  if (cleanedKnowledge) {
    sections.push(`Knowledge Base:\n${cleanedKnowledge}`);
  }
  sections.push(`Transcript:\n${transcript}`);
  sections.push(
    "Instructions: Identify each distinct question or request for information in the transcript and answer it concisely in one or two sentences. Use the knowledge base when relevant and mark those answers with source \"knowledge_base\". If the knowledge base lacks the information, answer from your general understanding and mark the source as \"general\"."
  );

  const userPrompt = sections.join("\n\n");

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const text = response.output_text?.trim() ?? "";
  if (!text) {
    return [];
  }

  const parsed = parseAnswerJson(text);

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
  return answers
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const question = typeof item.question === "string" ? item.question.trim() : "";
      const answer = typeof item.answer === "string" ? item.answer.trim() : "";
      const source = item.source === "knowledge_base" ? "knowledge_base" : "general";
      if (!question || !answer) return null;
      return { question, answer, source };
    })
    .filter(Boolean);
}

function parseAnswerJson(rawText) {
  if (!rawText) {
    return {};
  }

  const attempts = [];
  attempts.push(rawText.trim());
  attempts.push(
    rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim()
  );

  const braceMatch = rawText.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    attempts.push(braceMatch[0].trim());
  }

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      continue;
    }
  }

  throw new Error("Failed to parse AI response.");
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 940,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  WINDOWS.add(mainWindow);
  mainWindow.on("closed", () => {
    WINDOWS.delete(mainWindow);
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("set-api-key", async (event, key) => {
  if (typeof key !== "string" || !key.trim()) {
    openAIKey = "";
    openAIClient = null;
    return { ok: true, cleared: true, message: "API key cleared." };
  }

  openAIKey = key.trim();
  openAIClient = null;
  return { ok: true };
});

ipcMain.handle("get-api-key-status", async () => ({ hasKey: Boolean(openAIKey) }));

ipcMain.handle("transcribe-audio", async (event, payload) => {
  try {
    const response = await transcribePayload(payload || {});

    return { ok: true, text: response?.text ?? "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown transcription error.";
    dialog.showErrorBox("Transcription Failed", message);
    return { ok: false, error: message };
  }
});

ipcMain.handle("transcribe-partial", async (event, payload) => {
  try {
    const response = await transcribePayload(payload || {});
    return { ok: true, text: response?.text ?? "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown transcription error.";
    return { ok: false, error: message };
  }
});

ipcMain.handle("answer-questions", async (event, payload) => {
  try {
    const transcript = typeof payload?.transcript === "string" ? payload.transcript.trim() : "";
    const knowledgeBase = typeof payload?.knowledge === "string" ? payload.knowledge.trim() : "";

    if (!transcript) {
      return { ok: true, answers: [] };
    }

    const answers = await answerQuestionsFromTranscript(transcript, knowledgeBase);
    return { ok: true, answers };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate answers.";
    dialog.showErrorBox("Answer Generation Failed", message);
    return { ok: false, error: message };
  }
});
