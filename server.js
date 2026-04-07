const express = require("express");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: false }));

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Create a .env file from .env.example and set both values."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.post("/api/twilio/voice", async (req, res) => {
  res.set("Content-Type", "text/xml");

  await supabase.from("calls").insert({});

  res.send(`
    <Response>
      <Say>Welcome to AI support</Say>
      <Gather input="speech" action="/api/twilio/process" method="POST">
        <Say>Please tell your issue</Say>
      </Gather>
    </Response>
  `);
});

app.post("/api/twilio/process", async (req, res) => {
  const userInput = req.body.SpeechResult || "";

  await supabase.from("messages").insert({
    role: "user",
    content: userInput
  });

  const aiResponse = "This is a sample AI response";

  await supabase.from("messages").insert({
    role: "assistant",
    content: aiResponse
  });

  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Say>${aiResponse}</Say>
    </Response>
  `);
});

const requestedPort = Number(process.env.PORT) || 3000;
const hasExplicitPort = Boolean(process.env.PORT);

function startServer(port) {
  const server = app.listen(port, () => console.log("Server running on " + port));

  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") {
      throw error;
    }

    if (hasExplicitPort) {
      console.error(
        `Port ${port} is already in use. Stop the other process or set a different PORT in .env.`
      );
      process.exit(1);
    }

    const nextPort = port + 1;
    console.warn(`Port ${port} is busy. Retrying on ${nextPort}...`);
    startServer(nextPort);
  });
}

if (require.main === module) {
  startServer(requestedPort);
}

module.exports = { app, startServer };
