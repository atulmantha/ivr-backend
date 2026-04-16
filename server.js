const express = require("express");
const { randomUUID } = require("crypto");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { analyzeCustomerSpeech } = require("./decisionEngine");
require("dotenv").config();

const app = express();
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : true;

app.use(cors({ origin: corsOrigin }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY, APP_BASE_URL, PORT } =
  process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
  throw new Error(
    "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or GEMINI_API_KEY. Update .env using .env.example."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const requestedPort = Number(PORT) || 3000;
const hasExplicitPort = Boolean(PORT);

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
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
    console.warn("Customer phone lookup failed:", error.message);
    return null;
  }

  return data || null;
}

function getProcessActionUrl(req, callId) {
  const base = (APP_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  const url = new URL(`${base}/api/twilio/process`);
  if (callId) url.searchParams.set("call_id", callId);
  return url.toString();
}

function buildGatherTwiml(actionUrl) {
  const escaped = escapeXml(actionUrl);
  return `
    <Response>
      <Gather input="speech" action="${escaped}" method="POST" timeout="3" speechTimeout="1" bargeIn="true">
        <Pause length="1"/>
      </Gather>
      <Redirect method="POST">${escaped}</Redirect>
    </Response>
  `;
}

app.get("/", (_req, res) => res.send("Agent-assist IVR server running."));

app.post("/api/twilio/voice", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const callId = randomUUID();
    const callerPhone = String(req.body.From || req.body.Caller || "").trim() || null;

    const customer = callerPhone ? await lookupCustomerByPhone(callerPhone) : null;

    // Store call record (fire-and-forget — keep Twilio latency minimal)
    supabase
      .from("calls")
      .insert({
        id: callId,
        customer_phone: customer?.phone || callerPhone,
        customer_name: customer?.name || null,
        tier: customer?.tier || null,
        priority: "low",
      })
      .then(({ error }) => {
        if (error) {
          console.error("Failed to store call, retrying minimal:", error.message);
          supabase
            .from("calls")
            .insert({ id: callId, priority: "low" })
            .then(({ error: e2 }) => {
              if (e2) console.error("Fallback call insert failed:", e2.message);
            });
        }
      });

    res.send(buildGatherTwiml(getProcessActionUrl(req, callId)));
  } catch (error) {
    console.error("Voice route error:", error.message);
    res.set("Content-Type", "text/xml");
    res.send("<Response><Say>We are having trouble connecting. Please try again.</Say></Response>");
  }
});

app.post("/api/twilio/process", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const userInput = String(req.body.SpeechResult || "").trim();
    const incomingCallId = String(req.query.call_id || "").trim();
    const callId = isUuid(incomingCallId) ? incomingCallId : randomUUID();
    const nextActionUrl = getProcessActionUrl(req, callId);

    if (!isUuid(incomingCallId)) {
      console.warn("Invalid call_id. Using generated fallback.");
      supabase
        .from("calls")
        .insert({ id: callId, priority: "low" })
        .then(({ error }) => {
          if (error) console.error("Fallback call insert error:", error.message);
        });
    }

    // Respond immediately — AI does NOT speak to the customer
    res.send(buildGatherTwiml(nextActionUrl));

    // Background: store transcript → analyze → push results to dashboard
    if (userInput) {
      (async () => {
        // Store customer speech
        supabase
          .from("messages")
          .insert({ call_id: callId, role: "user", content: userInput })
          .then(({ error }) => {
            if (error) console.error("Message insert error:", error.message);
          });

        // Get customer tier for analysis context
        const { data: callData } = await supabase
          .from("calls")
          .select("tier")
          .eq("id", callId)
          .maybeSingle();
        const tier = callData?.tier || "Regular";

        // Run analysis
        const result = await analyzeCustomerSpeech(userInput, tier);

        // Persist analysis + update call priority (dashboard gets these via realtime)
        await Promise.all([
          supabase
            .from("analysis")
            .insert({
              call_id: callId,
              emotion: result.emotion,
              intent: result.intent,
              priority: result.priority,
              suggested_actions: result.suggested_actions,
            })
            .then(({ error }) => {
              if (error) console.error("Analysis insert error:", error.message);
            }),
          supabase
            .from("calls")
            .update({ priority: result.priority })
            .eq("id", callId)
            .then(({ error }) => {
              if (error) console.error("Call priority update error:", error.message);
            }),
        ]);
      })().catch((err) => console.error("Background analysis error:", err.message));
    }
  } catch (error) {
    console.error("Process route error:", error.message);
    res.send("<Response><Say>A brief issue occurred. Please continue.</Say></Response>");
  }
});

async function fetchCustomerDetails(req, res, overrides = {}) {
  const id = String(overrides.id ?? req.query.id ?? "").trim();
  const email = String(overrides.email ?? req.query.email ?? "").trim();
  const phone = String(overrides.phone ?? req.query.phone ?? "").trim();

  if (!id && !email && !phone) {
    return res
      .status(400)
      .json({ error: "Provide at least one query parameter: id, email, or phone." });
  }

  try {
    let query = supabase.from("customers").select("*").limit(1);

    if (id) query = query.eq("id", id);
    else if (email) query = query.eq("email", email);
    else query = query.in("phone", buildPhoneVariants(phone));

    const { data, error } = await query.maybeSingle();

    if (error) {
      console.error("Failed to fetch customer:", error.message);
      return res.status(500).json({ error: "Failed to fetch customer details." });
    }

    if (!data) return res.status(404).json({ error: "Customer not found." });

    return res.json({ customer: data });
  } catch (error) {
    console.error("customer-details error:", error.message);
    return res.status(500).json({ error: "Unexpected error." });
  }
}

app.get("/api/customer-details", (req, res) => fetchCustomerDetails(req, res));
app.get("/api/customers/:id", (req, res) =>
  fetchCustomerDetails(req, res, { id: req.params.id })
);

function startServer(port) {
  const server = app.listen(port, () =>
    console.log(`Agent-assist IVR server running on port ${port}`)
  );

  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") throw error;
    if (hasExplicitPort) {
      console.error(
        `Port ${port} is in use. Stop the other process or set a different PORT in .env.`
      );
      process.exit(1);
    }
    console.warn(`Port ${port} busy. Retrying on ${port + 1}...`);
    startServer(port + 1);
  });
}

if (require.main === module) {
  startServer(requestedPort);
}

module.exports = { app, startServer };
