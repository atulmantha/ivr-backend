process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role-key";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-gemini-api-key";
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "https://ivr-backend-aab6.onrender.com";

jest.mock("@supabase/supabase-js", () => {
  const insert = jest.fn().mockResolvedValue({ data: null, error: null });
  const from = jest.fn().mockReturnValue({ insert });

  return {
    createClient: jest.fn(() => ({ from })),
  };
});

const request = require("supertest");
const { app } = require("../server");

describe("POST /api/twilio/voice", () => {
  it("returns TwiML XML for a Twilio-style form-urlencoded request", async () => {
    const response = await request(app)
      .post("/api/twilio/voice")
      .type("form")
      .send({
        CallSid: "CA1234567890abcdef",
        AccountSid: "AC1234567890abcdef",
        From: "+14155551234",
        To: "+14155559876",
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/xml");
    expect(response.text).toContain("<Response>");
    expect(response.text).toContain("<Say>Welcome to AI support.</Say>");
    expect(response.text).toContain(
      '<Gather input="speech" action="https://ivr-backend-aab6.onrender.com/api/twilio/process?call_id='
    );
    expect(response.text).toContain('" method="POST">');
  });
});
