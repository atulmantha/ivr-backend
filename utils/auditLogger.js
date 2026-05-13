const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAudit = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

async function logAuditEvent({ userId = null, actionType, entityType, entityId = null, metadata = null }) {
  if (!supabaseAudit) {
    console.warn("[audit] Supabase audit client not configured; skipping audit event.");
    return;
  }

  try {
    const payload = {
      user_id:    userId,
      action_type: actionType,
      entity_type: entityType,
      entity_id:   entityId,
      metadata:    metadata || null,
    };

    const { error } = await supabaseAudit.from("audit_logs").insert(payload);
    if (error) {
      console.error("[audit] insert error:", error.message);
    }
  } catch (err) {
    console.error("[audit] unexpected error:", err?.message || err);
  }
}

module.exports = { logAuditEvent };