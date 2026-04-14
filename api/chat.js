function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 120_000) {
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const SYSTEM_PROMPT = `You are "Bubbe's Morning Friend," a warm, patient companion for mornings. Your tone is gentle, simple, and respectful—like a kind friend or family member. Use short paragraphs and plain language. You may invite small memories, light conversation, quiet companionship, or gentle encouragement.

Rules:
- You are not a doctor or therapist. If the user asks for medical advice or describes symptoms, pain, emergencies, medications, or diagnoses, do not advise—encourage them to contact their doctor or emergency services if needed.
- Do not claim to remember things beyond this conversation; stay in the present chat.
- Keep replies concise (roughly 2–5 short paragraphs unless they ask for less).
- Match the user's emotional pace; offer silence or quiet presence if they want to "just sit" together.`;
const MEDICAL_RISK_RE = /\b(doctor|pain|chest|medicine|blood pressure|symptom|diagnosis|emergency|hospital)\b/i;

function makeRequestId() {
  return `bmf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isSafetyLoggingEnabled() {
  return process.env.SAFETY_LOGGING !== "0";
}

function logSafety(event, payload) {
  if (!isSafetyLoggingEnabled()) return;
  console.log("[safety]", JSON.stringify({ event, ...payload }));
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const allowed = new Set(["user", "assistant"]);
  const out = [];
  for (const m of raw.slice(-40)) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    if (!allowed.has(role)) continue;
    const content = typeof m.content === "string" ? m.content.trim().slice(0, 8000) : "";
    if (!content) continue;
    out.push({ role, content });
  }
  return out.length ? out : null;
}

module.exports = async (req, res) => {
  const startedAt = Date.now();
  const requestId = makeRequestId();
  res.setHeader("Content-Type", "application/json");
  res.setHeader("X-Request-Id", requestId);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sitePassword = process.env.SITE_PASSWORD;
  if (!sitePassword && req.headers["x-auth-probe"] === "1") {
    return res.status(204).end();
  }
  if (sitePassword) {
    const provided = req.headers["x-site-password"];
    if (!provided || provided !== sitePassword) {
      logSafety("auth_failed", { requestId });
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (req.headers["x-auth-probe"] === "1") {
      return res.status(204).end();
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "OpenAI is not configured (missing OPENAI_API_KEY)." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = body ? JSON.parse(body) : {};
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }

  if (!body || typeof body !== "object") {
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return res.status(413).json({ error: "Request too large" });
    }
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }

  const sanitized = sanitizeMessages(body.messages);
  if (!sanitized) {
    return res.status(400).json({ error: "messages must be a non-empty array of user/assistant turns" });
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const lastUserMessage = [...sanitized].reverse().find((m) => m.role === "user")?.content || "";
  const hadMedicalRiskSignal = MEDICAL_RISK_RE.test(lastUserMessage);

  logSafety("request_received", {
    requestId,
    model,
    turnCount: sanitized.length,
    hadMedicalRiskSignal,
  });

  let openaiRes;
  try {
    openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...sanitized],
        temperature: 0.7,
        max_tokens: 600,
      }),
    });
  } catch (err) {
    logSafety("openai_unreachable", {
      requestId,
      model,
      hadMedicalRiskSignal,
      latencyMs: Date.now() - startedAt,
      error: err?.message || "fetch_failed",
    });
    return res.status(502).json({ error: "Could not reach OpenAI" });
  }

  const data = await openaiRes.json().catch(() => ({}));
  if (!openaiRes.ok) {
    const msg = data.error?.message || "OpenAI request failed";
    logSafety("openai_error", {
      requestId,
      model,
      hadMedicalRiskSignal,
      latencyMs: Date.now() - startedAt,
      status: openaiRes.status,
      errorCode: data.error?.code || null,
      errorType: data.error?.type || null,
      message: msg,
    });
    return res.status(502).json({ error: msg });
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    logSafety("empty_model_response", {
      requestId,
      model,
      hadMedicalRiskSignal,
      latencyMs: Date.now() - startedAt,
    });
    return res.status(502).json({ error: "Empty model response" });
  }

  logSafety("request_succeeded", {
    requestId,
    model,
    hadMedicalRiskSignal,
    latencyMs: Date.now() - startedAt,
    usage: data.usage || null,
  });

  return res.status(200).json({ reply: text });
};
