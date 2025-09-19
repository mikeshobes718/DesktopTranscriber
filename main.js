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
  });
}

async function answerQuestionsFromTranscript(transcript) {
  const client = getClient();
  const systemPrompt =
    "You are an assistant that extracts questions from a transcript and answers them accurately. " +
    "If there are no questions, respond with an empty array.";
  const userPrompt = `Transcript:\n${transcript}`;

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          "Identify every distinct question asked in the transcript and answer it concisely. " +
          "Respond strictly as JSON with the shape {\"answers\":[{\"question\":string,\"answer\":string}]}.",
      },
      { role: "user", content: userPrompt },
    ],
  });

  const text = response.output_text?.trim() ?? "";
  if (!text) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Attempt to recover by extracting JSON snippet
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error("Failed to parse AI response.");
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const answers = Array.isArray(parsed.answers) ? parsed.answers : [];
  return answers
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const question = typeof item.question === "string" ? item.question.trim() : "";
      const answer = typeof item.answer === "string" ? item.answer.trim() : "";
      if (!question || !answer) return null;
      return { question, answer };
    })
    .filter(Boolean);
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

ipcMain.handle("answer-questions", async (event, transcript) => {
  try {
    if (typeof transcript !== "string" || !transcript.trim()) {
      return { ok: true, answers: [] };
    }

    const answers = await answerQuestionsFromTranscript(transcript.trim());
    return { ok: true, answers };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate answers.";
    dialog.showErrorBox("Answer Generation Failed", message);
    return { ok: false, error: message };
  }
});
