const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

let deepgram = null;

function getDeepgramClient() {
  if (!process.env.DEEPGRAM_API_KEY) return null;
  if (!deepgram) deepgram = createClient(process.env.DEEPGRAM_API_KEY);
  return deepgram;
}

/**
 * Attaches Deepgram real-time transcription to a Twilio Media Streams WebSocket.
 *
 * @param {WebSocket} ws            - The incoming WebSocket connection from Twilio
 * @param {string}    callId        - UUID identifying the call
 * @param {string}    role          - "customer" or "agent"
 * @param {object}    supabase      - Supabase client
 * @param {Function}  onTranscript  - Callback({ callId, role, transcript }) for post-processing
 */
function handleMediaStream(ws, callId, role, supabase, onTranscript) {
  const client = getDeepgramClient();

  if (!client) {
    console.warn("Deepgram API key not set — transcription disabled.");
    ws.on("message", () => {}); // drain messages silently
    return;
  }

  let dgConnection = null;
  let isOpen = false;
  const audioQueue = [];
  let keepAliveInterval = null;

  const openConnection = () => {
    dgConnection = client.listen.live({
      model: "nova-2-phonecall",
      encoding: "mulaw",
      sample_rate: 8000,
      channels: 1,
      language: "en-US",
      interim_results: false,
      endpointing: 300,
      utterance_end_ms: 1000,
    });

    dgConnection.on(LiveTranscriptionEvents.Open, () => {
      isOpen = true;
      console.log(`Deepgram open [${role}] callId=${callId}`);

      // Flush any audio that arrived before Deepgram was ready
      while (audioQueue.length > 0) {
        dgConnection.send(audioQueue.shift());
      }

      // Send keepalive every 10s so the connection doesn't idle-close
      keepAliveInterval = setInterval(() => {
        if (isOpen) {
          try {
            dgConnection.keepAlive();
          } catch (_) {}
        }
      }, 10_000);
    });

    dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
      const transcript = data?.channel?.alternatives?.[0]?.transcript?.trim();
      if (!transcript || !data.is_final) return;

      const dbRole = role === "agent" ? "agent" : "user";

      // Store message to Supabase (non-blocking)
      supabase
        .from("messages")
        .insert({ call_id: callId, role: dbRole, content: transcript })
        .then(({ error }) => {
          if (error) console.error(`Message insert error [${role}]:`, error.message);
        });

      // Notify caller for further processing (RAG etc.)
      if (onTranscript) {
        try {
          await onTranscript({ callId, role, transcript });
        } catch (err) {
          console.error("onTranscript callback error:", err.message);
        }
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error(`Deepgram error [${role}]:`, err?.message || err);
      isOpen = false;
    });

    dgConnection.on(LiveTranscriptionEvents.Close, () => {
      isOpen = false;
      clearInterval(keepAliveInterval);
      console.log(`Deepgram closed [${role}] callId=${callId}`);
    });
  };

  openConnection();

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.event === "start") {
        console.log(`Media stream started [${role}] callId=${callId} streamSid=${msg.start?.streamSid}`);
      }

      if (msg.event === "media") {
        const audio = Buffer.from(msg.media.payload, "base64");
        if (isOpen && dgConnection) {
          dgConnection.send(audio);
        } else {
          audioQueue.push(audio);
        }
      }

      if (msg.event === "stop") {
        console.log(`Media stream stopped [${role}] callId=${callId}`);
        if (dgConnection) {
          try { dgConnection.requestClose(); } catch (_) {}
        }
      }
    } catch (err) {
      console.error("Media stream parse error:", err.message);
    }
  });

  ws.on("close", () => {
    clearInterval(keepAliveInterval);
    if (dgConnection) {
      try { dgConnection.requestClose(); } catch (_) {}
    }
  });

  ws.on("error", (err) => {
    console.error(`Media stream WS error [${role}]:`, err.message);
  });
}

module.exports = { handleMediaStream };
