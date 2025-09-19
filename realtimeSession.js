const WebSocket = require("ws");
const { Buffer } = require("buffer");

function createRealtimeUrl(model) {
  const encodedModel = encodeURIComponent(model);
  return `wss://api.openai.com/v1/realtime?model=${encodedModel}`;
}

class RealtimeTranscriptionSession {
  constructor({
    apiKey,
    model = "gpt-4o-mini-transcribe",
    onPartial,
    onFinal,
    onError,
  }) {
    this.apiKey = apiKey;
    this.model = model;
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.onError = onError;
    this.ws = null;
    this.isReady = false;
    this.pendingChunks = [];
    this.partialText = "";
    this.lastResponseId = null;
  }

  async start() {
    if (!this.apiKey) {
      throw new Error("Missing OpenAI API key for realtime session.");
    }

    return new Promise((resolve, reject) => {
      const url = createRealtimeUrl(this.model);
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws = ws;

      ws.on("open", () => {
        this.isReady = true;
        this.partialText = "";
        resolve(true);
      });

      ws.on("message", (message) => {
        this.handleMessage(message);
      });

      ws.on("error", (error) => {
        if (!this.isReady) {
          reject(error);
        } else if (this.onError) {
          this.onError(error);
        }
      });

      ws.on("close", () => {
        this.isReady = false;
      });
    });
  }

  handleMessage(message) {
    let event;
    try {
      event = JSON.parse(message.toString());
    } catch (error) {
      if (this.onError) {
        this.onError(error);
      }
      return;
    }

    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) {
          this.partialText += event.delta;
          if (this.onPartial) {
            this.onPartial(this.partialText, false);
          }
        }
        break;
      case "response.completed":
        if (event.response && event.response.output_text) {
          const finalText = Array.isArray(event.response.output_text)
            ? event.response.output_text.join("")
            : String(event.response.output_text ?? "");
          this.partialText = finalText.trim();
          if (this.onPartial) {
            this.onPartial(this.partialText, true);
          }
          if (this.onFinal) {
            this.onFinal(this.partialText);
          }
        }
        break;
      case "error":
        if (this.onError) {
          const err = new Error(event.error?.message || "Realtime session error");
          this.onError(err);
        }
        break;
      default:
        break;
    }
  }

  async sendChunk(buffer, mimeType = "audio/webm") {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Realtime connection not ready.");
    }

    const base64 = Buffer.from(buffer).toString("base64");
    const appendPayload = {
      type: "input_audio_buffer.append",
      audio: {
        data: base64,
      },
    };

    this.ws.send(JSON.stringify(appendPayload));
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.ws.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["text"],
          instructions:
            "Provide a running transcription of the audio input. Return only the transcript text.",
        },
      })
    );
  }

  stop() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "session-end");
    }
    this.ws = null;
    this.isReady = false;
  }
}

module.exports = {
  RealtimeTranscriptionSession,
};
