// api/render-and-email.mjs
import nodemailer from "nodemailer";
import OpenAI from "openai";

// ---------- CONFIG ----------
const KNOWN_ALLERGENS = ["eggs", "dairy", "peanuts", "tree_nuts", "shellfish", "soy"];
const SUPPORTED_LANGS = ["en", "fr", "es", "pt", "zh"];

// CORS for browser tests
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function normalizeAllergensFromBody(body) {
  const direct = body?.allergens;
  if (Array.isArray(direct)) {
    const norm = direct
      .map(s => String(s).trim().toLowerCase().replace(/\s+/g, "_"))
      .filter(v => KNOWN_ALLERGENS.includes(v));
    if (norm.length) return norm;
  }
  if (typeof direct === "string") {
    const norm = direct
      .split(",")
      .map(s => s.trim().toLowerCase().replace(/\s+/g, "_"))
      .filter(v => KNOWN_ALLERGENS.includes(v));
    if (norm.length) return norm;
  }

  const fields = body || {};
  const fromCheckboxes = Object.keys(fields)
    .filter(k => k.startsWith("allergens_") && fields[k])
    .map(k => k.replace("allergens_", "").toLowerCase());

  return fromCheckboxes
    .map(v => v.replace(/\s+/g, "_"))
    .filter(v => KNOWN_ALLERGENS.includes(v));
}

function normalizeLanguage(lang) {
  const v = String(lang || "").trim().toLowerCase();
  return SUPPORTED_LANGS.includes(v) ? v : "en";
}

function fallbackCard({ name, allergens, contact_name, contact_phone, language }) {
  const allergenList =
    allergens.length ? allergens.join(", ").replace(/_/g, " ") : "None specified";
  const lines = [
    `Name: ${name}`,
    `I am severely allergic to: ${allergenList}`,
    `Please DO NOT serve me food containing these allergens.`,
    `Emergency Contact: ${contact_name} ${contact_phone ? `(${contact_phone})` : ""}`.trim(),
    `Language: ${language.toUpperCase()}`
  ];
  return lines.join("\n");
}

async function generateCardWithAI({ name, allergens, contact_name, contact_phone, language }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const allergenList = allergens.length ? allergens.join(", ").replace(/_/g, " ") : "none";
  const prompt = `
You are an expert translator and accessibility writer.
Write a SHORT emergency allergy card in ${language} with clear lines.
Use the following fields. Keep it concise and friendly, no extra commentary.
- Name: ${name}
- Allergens: ${allergenList}
- Instruction: "Please DO NOT serve me food containing these allergens."
- Emergency Contact: ${contact_name}${contact_phone ? ` (${contact_phone})` : ""}

Output plain text only. Use line breaks. Do not add quotes or markdown.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
  });

  const text = response?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned empty content");
  return text;
}

function buildTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error("Missing SMTP envs (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS).");
  }

  const port = Number(SMTP_PORT);
  const secure = port === 465;

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return transporter;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "POST only" });
    }

    const body = req.body || {};
    // Log a sanitized snapshot (no secrets)
    console.log("Incoming body keys:", Object.keys(body));

    const clean = {
      email: String(body.email || "").trim(),
      name: String(body.name || "").trim(),
      contact_name: String(body.contact_name || "").trim(),
      contact_phone: String(body.contact_phone || "").trim(),
      language: normalizeLanguage(body.language),
      allergens: normalizeAllergensFromBody(body),
    };

    if (!clean.email || !clean.name) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: name, email",
        received: { email: !!clean.email, name: !!clean.name },
      });
    }

    // Generate card
    let cardText;
    try {
      cardText = await generateCardWithAI(clean);
    } catch (e) {
      console.error("OpenAI error:", e?.message);
      cardText = fallbackCard(clean);
    }

    // Build & verify SMTP
    const transporter = buildTransporter();
    try {
      await transporter.verify();
      console.log("SMTP verify OK");
    } catch (e) {
      console.error("SMTP verify failed:", e?.message);
      throw new Error("SMTP auth failed: " + (e?.message || "unknown"));
    }

    // Compose email
    const from = process.env.EMAIL_FROM;
    if (!from) throw new Error("Missing EMAIL_FROM (must be a verified sender in Brevo).");

    const subject = `Allergy Card for ${clean.name}`;
    const html = `
      <div style="font-family:system-ui,Arial,sans-serif;white-space:pre-wrap;line-height:1.45">
        ${cardText.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
      </div>
    `;

    await transporter.sendMail({
      from,
      to: clean.email,
      subject,
      text: cardText,
      html,
    });

    return res.status(200).json({ ok: true, emailed_to: clean.email });
  } catch (err) {
    console.error("SERVER ERROR:", err?.message, err?.stack);
    // Return the message so we can see it in tools like Hoppscotch, and it will
    // appear in Vercel Runtime Logs too.
    return res.status(500).json({ ok: false, error: err?.message || "Internal error" });
  }
}
