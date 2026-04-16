// =============================================================
// Required env vars (add to .env):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY
//   DEEPGRAM_API_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   TWILIO_API_KEY, TWILIO_API_SECRET       (create in Twilio Console → API keys)
//   TWILIO_TWIML_APP_SID                    (create a TwiML App, Voice URL = APP_BASE_URL/api/twilio/agent)
//   TWILIO_PHONE_NUMBER                     (your Twilio number, e.g. +14155551234)
//   APP_BASE_URL                            (public HTTPS URL of this server)
//   CORS_ORIGIN, PORT
// =============================================================

const express  = require("express");
const http     = require("http");
const { randomUUID } = require("crypto");
const cors     = require("cors");
const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");
const twilio   = require("twilio");
const { analyzeCustomerSpeech }                            = require("./decisionEngine");
const { generateEmbedding, searchKnowledge, generateSuggestedReply } = require("./ragService");
const { handleMediaStream }                                = require("./transcriptionService");
const { upload, extractText, chunkText }                   = require("./uploadService");
require("dotenv").config({ quiet: true });

// ── App + HTTP server (needed for WebSocket upgrade) ──────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

// ── CORS ──────────────────────────────────────────────────────
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : true;

app.use(cors({ origin: corsOrigin }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Env validation ────────────────────────────────────────────
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GEMINI_API_KEY,
  APP_BASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_PHONE_NUMBER,
  PORT,
} = process.env;

const MISSING_VARS = [
  ["SUPABASE_URL",            SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY],
  ["GEMINI_API_KEY",          GEMINI_API_KEY],
].filter(([, v]) => !v).map(([k]) => k);

if (MISSING_VARS.length > 0) {
  console.error(`[startup] Missing required environment variable(s): ${MISSING_VARS.join(", ")}`);
  console.error("[startup] Set these in your Render dashboard → Environment, then redeploy.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Twilio REST client (optional — only needed for dialling agents)
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// Derive WebSocket base URL from APP_BASE_URL
const BASE_URL = (APP_BASE_URL || "").replace(/\/+$/, "");
const WS_BASE_URL = BASE_URL
  .replace("https://", "wss://")
  .replace("http://",  "ws://");

const port          = Number(PORT) || 3000;
const hasExplicitPort = Boolean(PORT);

// ── Startup diagnostics ──────────────────────────────────────
console.log("[startup] APP_BASE_URL    :", BASE_URL    || "(not set — WebSocket streams will fail!)");
console.log("[startup] WS_BASE_URL     :", WS_BASE_URL || "(not set — WebSocket streams will fail!)");
console.log("[startup] Twilio client   :", twilioClient ? "configured" : "NOT configured (missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN)");
console.log("[startup] Agent target    :", process.env.AGENT_PHONE_NUMBER || "client:agent (browser softphone)");
console.log("[startup] DEEPGRAM_API_KEY:", process.env.DEEPGRAM_API_KEY ? `set (starts with ${process.env.DEEPGRAM_API_KEY.slice(0, 6)}...)` : "NOT SET — transcription will fail!");

// Test Deepgram key at startup via REST API
if (process.env.DEEPGRAM_API_KEY) {
  fetch("https://api.deepgram.com/v1/projects", {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  }).then((r) => {
    if (r.ok) {
      console.log("[startup] Deepgram key verified ✓ (status", r.status, ")");
    } else {
      console.error(`[startup] Deepgram key INVALID — HTTP ${r.status}. Get a new key at console.deepgram.com`);
    }
  }).catch((err) => {
    console.error("[startup] Deepgram connectivity test failed:", err.message);
  });
}

// ── Helpers ───────────────────────────────────────────────────
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildPhoneVariants(rawPhone) {
  const digitsOnly = String(rawPhone || "").replace(/\D/g, "");
  if (!digitsOnly) return [rawPhone].filter(Boolean);

  const lastTen = digitsOnly.slice(-10);
  const variants = new Set([rawPhone, digitsOnly, `+${digitsOnly}`]);

  if (digitsOnly.length === 10) {
    variants.add(`1${digitsOnly}`);
    variants.add(`+1${digitsOnly}`);
  }
  if (digitsOnly.length > 10) {
    variants.add(lastTen);
    variants.add(`+1${lastTen}`);
    variants.add(`1${lastTen}`);
  }

  return Array.from(variants).filter(Boolean);
}

async function lookupCustomerByPhone(rawPhone) {
  if (!rawPhone) return null;

  const variants = buildPhoneVariants(rawPhone);
  if (variants.length === 0) return null;

  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .in("phone", variants)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("Customer lookup failed:", error.message);
    return null;
  }
  return data || null;
}

// ── Conference TwiML builders ─────────────────────────────────
// NOTE: call_id and role are passed as <Parameter> elements, NOT as URL query
// params. Render's reverse proxy strips query params from WebSocket upgrades,
// so we embed them in the TwiML and read them from the Twilio 'start' event.
function customerConferenceTwiml(callId) {
  const streamUrl = escapeXml(`${WS_BASE_URL}/api/media-stream`);
  const statusUrl = escapeXml(`${BASE_URL}/api/conference-status?call_id=${callId}`);
  const room      = `room-${callId}`;

  console.log("[twiml] Customer stream URL:", `${WS_BASE_URL}/api/media-stream`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${streamUrl}" track="inbound_track">
      <Parameter name="call_id" value="${escapeXml(callId)}"/>
      <Parameter name="role" value="customer"/>
    </Stream>
  </Start>
  <Dial>
    <Conference beep="false"
                waitUrl="https://twimlets.com/holdmusic?Bucket=com.twilio.music.classical"
                statusCallbackEvent="end"
                statusCallback="${statusUrl}">
      ${room}
    </Conference>
  </Dial>
</Response>`;
}

function agentConferenceTwiml(callId) {
  const streamUrl = escapeXml(`${WS_BASE_URL}/api/media-stream`);
  const room      = `room-${callId}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${streamUrl}" track="inbound_track">
      <Parameter name="call_id" value="${escapeXml(callId)}"/>
      <Parameter name="role" value="agent"/>
    </Stream>
  </Start>
  <Dial>
    <Conference beep="false" waitUrl="">
      ${room}
    </Conference>
  </Dial>
</Response>`;
}

// ── Routes ────────────────────────────────────────────────────

app.get("/", (_req, res) => res.send("Agent-assist IVR server running."));

// -- Twilio Access Token for agent browser softphone ----------
app.get("/api/token", (_req, res) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET) {
    return res.status(503).json({ error: "Twilio credentials not configured." });
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant  = AccessToken.VoiceGrant;

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY,
    TWILIO_API_SECRET,
    { identity: "agent", ttl: 3600 }
  );

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID || undefined,
    incomingAllow: true,
  });

  token.addGrant(voiceGrant);
  return res.json({ token: token.toJwt() });
});

// -- Customer calls in → Conference TwiML + dial agent --------
app.post("/api/twilio/voice", async (req, res) => {
  res.set("Content-Type", "text/xml");

  const callId      = randomUUID();
  const callerPhone = String(req.body.From || req.body.Caller || "").trim() || null;

  console.log(`\n[voice] ── Incoming call ──────────────────────`);
  console.log(`[voice] callId       : ${callId}`);
  console.log(`[voice] callerPhone  : ${callerPhone || "(unknown)"}`);
  console.log(`[voice] BASE_URL     : ${BASE_URL || "(NOT SET — agent URL will be broken!)"}`);
  console.log(`[voice] WS_BASE_URL  : ${WS_BASE_URL || "(NOT SET — media stream will fail!)"}`);
  console.log(`[voice] twilioClient : ${twilioClient ? "OK" : "MISSING (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set)"}`);
  console.log(`[voice] TWILIO_PHONE : ${TWILIO_PHONE_NUMBER || "(NOT SET)"}`);

  try {
    const customer = callerPhone ? await lookupCustomerByPhone(callerPhone) : null;
    console.log(`[voice] customer     : ${customer ? `${customer.name} / tier=${customer.tier}` : "not found in DB"}`);

    // Insert call record immediately (fire-and-forget)
    supabase.from("calls").insert({
      id:             callId,
      customer_phone: customer?.phone || callerPhone,
      customer_name:  customer?.name  || null,
      tier:           customer?.tier  || null,
      priority:       "low",
    }).then(({ error }) => {
      if (error) console.error("[voice] Call insert error:", error.message);
      else console.log(`[voice] Call inserted in DB ✓`);
    });

    // Dial agent browser (laptop dashboard)
    if (twilioClient && TWILIO_PHONE_NUMBER) {
      const agentUrl = `${BASE_URL}/api/twilio/agent?call_id=${callId}`;
      console.log(`[voice] Dialling agent → client:agent`);
      console.log(`[voice] Agent TwiML URL : ${agentUrl}`);
      twilioClient.calls.create({
        to:   "client:agent",
        from: TWILIO_PHONE_NUMBER,
        url:  agentUrl,
      }).then((call) => {
        console.log(`[voice] Agent call created ✓ SID=${call.sid}`);
      }).catch((err) => {
        console.error(`[voice] Agent dial FAILED: ${err.message}`);
        console.error(`[voice] Twilio error code : ${err.code || "n/a"}`);
        console.error(`[voice] Twilio more info  : ${err.moreInfo || "n/a"}`);
      });
    } else {
      console.warn("[voice] ERROR: Twilio client not configured — agent NOT dialled.");
      console.warn(`[voice]   TWILIO_ACCOUNT_SID : ${TWILIO_ACCOUNT_SID ? "set" : "MISSING"}`);
      console.warn(`[voice]   TWILIO_AUTH_TOKEN  : ${TWILIO_AUTH_TOKEN  ? "set" : "MISSING"}`);
      console.warn(`[voice]   TWILIO_PHONE_NUMBER: ${TWILIO_PHONE_NUMBER ? "set" : "MISSING"}`);
    }

    res.send(customerConferenceTwiml(callId));
    console.log(`[voice] Customer TwiML sent ✓`);
  } catch (error) {
    console.error("[voice] Unexpected error:", error.message);
    res.send(customerConferenceTwiml(callId));
  }
});

// -- Agent leg TwiML (called by Twilio when agent answers) ----
app.post("/api/twilio/agent", (req, res) => {
  res.set("Content-Type", "text/xml");

  const callId = String(req.query.call_id || "").trim();
  if (!callId) {
    return res.send("<Response><Hangup/></Response>");
  }

  res.send(agentConferenceTwiml(callId));
});

// -- Conference status callback (called when conference ends) -
app.post("/api/conference-status", (req, res) => {
  const callId = String(req.query.call_id || "").trim();
  const event  = req.body.StatusCallbackEvent;

  if (event === "conference-end" && callId) {
    console.log(`Conference ended callId=${callId}`);
    // Optionally update call end time or duration here
  }

  res.status(200).end();
});

// -- Knowledge base: add text content + embedding -------------
app.post("/api/knowledge", async (req, res) => {
  const content = String(req.body.content || "").trim();
  const source  = String(req.body.source  || "").trim();

  if (!content) {
    return res.status(400).json({ error: "content is required." });
  }

  try {
    const embedding = await generateEmbedding(content);

    const { error } = await supabase.from("knowledge_base").insert({
      content,
      source:    source || null,
      embedding,
    });

    if (error) throw new Error(error.message);

    return res.json({ success: true, chunks: 1 });
  } catch (err) {
    console.error("Knowledge insert error:", err.message);
    return res.status(500).json({ error: "Failed to add to knowledge base." });
  }
});

// -- Knowledge base: upload file (PDF / DOCX / TXT / CSV) -----
app.post("/api/knowledge/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  const source = req.file.originalname;

  let chunks;
  try {
    const rawText = await extractText(req.file);
    if (!rawText.trim()) {
      return res.status(422).json({ error: "Could not extract text from file." });
    }

    chunks = chunkText(rawText);
    if (chunks.length === 0) {
      return res.status(422).json({ error: "File appears to be empty." });
    }
  } catch (err) {
    console.error("File parse error:", err.message);
    return res.status(422).json({ error: "Failed to parse file content." });
  }

  // Respond immediately — embedding can take minutes for large files.
  // Processing continues in the background.
  res.json({
    success:      true,
    file:         source,
    total_chunks: chunks.length,
    inserted_chunks: chunks.length, // optimistic; errors logged below
    status:       "processing",
  });

  // Background: embed and insert each chunk sequentially (avoid rate limits)
  (async () => {
    let inserted = 0;
    for (const chunk of chunks) {
      try {
        const embedding = await generateEmbedding(chunk);
        const { error } = await supabase.from("knowledge_base").insert({
          content:   chunk,
          source,
          embedding,
        });
        if (error) {
          console.error(`Chunk insert error (${source}):`, error.message);
        } else {
          inserted++;
        }
      } catch (chunkErr) {
        console.error(`Embedding error (${source}):`, chunkErr.message);
      }
    }
    console.log(`[upload] ${source}: inserted ${inserted}/${chunks.length} chunks`);
  })();
});

// Multer error handler
app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large. Max 10MB." });
  }
  if (err?.message) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: "Unexpected error." });
});

// -- Customer details -----------------------------------------
async function fetchCustomerDetails(req, res, overrides = {}) {
  const id    = String(overrides.id    ?? req.query.id    ?? "").trim();
  const email = String(overrides.email ?? req.query.email ?? "").trim();
  const phone = String(overrides.phone ?? req.query.phone ?? "").trim();

  if (!id && !email && !phone) {
    return res.status(400).json({ error: "Provide id, email, or phone." });
  }

  try {
    let query = supabase.from("customers").select("*").limit(1);

    if (id)    query = query.eq("id", id);
    else if (email) query = query.eq("email", email);
    else       query = query.in("phone", buildPhoneVariants(phone));

    const { data, error } = await query.maybeSingle();

    if (error) {
      console.error("Customer fetch error:", error.message);
      return res.status(500).json({ error: "Failed to fetch customer." });
    }

    if (!data) return res.status(404).json({ error: "Customer not found." });

    return res.json({ customer: data });
  } catch (err) {
    console.error("customer-details error:", err.message);
    return res.status(500).json({ error: "Unexpected error." });
  }
}

app.get("/api/customer-details", (req, res) => fetchCustomerDetails(req, res));
app.get("/api/customers/:id",    (req, res) => fetchCustomerDetails(req, res, { id: req.params.id }));

// ── WebSocket: Twilio Media Streams ──────────────────────────
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/media-stream") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  const url          = new URL(req.url, "http://localhost");
  const callIdFromUrl = url.searchParams.get("call_id");
  const roleFromUrl   = url.searchParams.get("role");

  // Local dev: query params survive → start immediately
  if (callIdFromUrl && isUuid(callIdFromUrl)) {
    console.log(`[ws] Connected (URL params): role=${roleFromUrl} callId=${callIdFromUrl}`);
    startMediaStream(ws, callIdFromUrl, roleFromUrl || "customer");
    return;
  }

  // Render strips query params from WebSocket upgrades.
  // Read call_id + role from Twilio's 'start' event customParameters instead.
  console.log(`[ws] No call_id in URL (Render proxy stripped params) — waiting for Twilio start event`);

  const onStartEvent = (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event !== "start") return;

      const params = msg.start?.customParameters || {};
      const callId = String(params.call_id || "").trim();
      const role   = String(params.role    || "customer").trim();

      ws.removeListener("message", onStartEvent);

      if (!callId || !isUuid(callId)) {
        console.error(`[ws] start event has no valid call_id. customParameters=${JSON.stringify(params)}`);
        ws.close();
        return;
      }

      console.log(`[ws] Resolved from start event: role=${role} callId=${callId}`);
      startMediaStream(ws, callId, role);
    } catch (err) {
      console.error("[ws] Start event parse error:", err.message);
    }
  };

  ws.on("message", onStartEvent);
  ws.on("close", () => ws.removeListener("message", onStartEvent));
});

function startMediaStream(ws, callId, role) {
  handleMediaStream(ws, callId, role, supabase, async ({ transcript }) => {
    if (role !== "customer") return;

    console.log(`[analysis] Transcript: "${transcript.slice(0, 80)}"`);

    try {
      const { data: callData } = await supabase
        .from("calls").select("tier").eq("id", callId).maybeSingle();
      const tier = callData?.tier || "Regular";

      const [analysisResult, embedding] = await Promise.all([
        analyzeCustomerSpeech(transcript, tier),
        generateEmbedding(transcript).catch((err) => {
          console.error("[analysis] Embedding error:", err.message);
          return null;
        }),
      ]);

      console.log(`[analysis] emotion=${analysisResult.emotion} intent=${analysisResult.intent} priority=${analysisResult.priority}`);

      const contextChunks = embedding ? await searchKnowledge(supabase, embedding) : [];
      console.log(`[analysis] RAG chunks: ${contextChunks.length}`);

      const suggestedReply = await generateSuggestedReply(transcript, contextChunks, tier);
      console.log(`[analysis] Reply: "${(suggestedReply || "").slice(0, 80)}"`);

      await Promise.all([
        supabase.from("analysis").insert({
          call_id:           callId,
          emotion:           analysisResult.emotion,
          intent:            analysisResult.intent,
          priority:          analysisResult.priority,
          suggested_actions: analysisResult.suggested_actions,
          suggested_reply:   suggestedReply,
        }).then(({ error }) => {
          if (error) console.error("[analysis] Insert error:", error.message);
          else console.log("[analysis] Saved to DB ✓");
        }),

        supabase.from("calls").update({ priority: analysisResult.priority })
          .eq("id", callId)
          .then(({ error }) => {
            if (error) console.error("[analysis] Priority update error:", error.message);
          }),
      ]);
    } catch (err) {
      console.error("[analysis] Pipeline error:", err.message, err.stack);
    }
  });
}

// ── Start server ──────────────────────────────────────────────
function startServer(p) {
  server.listen(p, () =>
    console.log(`Agent-assist IVR server running on port ${p}`)
  );

  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") throw error;
    if (hasExplicitPort) {
      console.error(`Port ${p} is in use. Set a different PORT in .env.`);
      process.exit(1);
    }
    console.warn(`Port ${p} busy. Retrying on ${p + 1}...`);
    startServer(p + 1);
  });
}

if (require.main === module) {
  startServer(port);
}

module.exports = { app, server };
