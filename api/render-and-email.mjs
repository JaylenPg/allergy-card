// api/render-and-email.mjs
import nodemailer from "nodemailer";
import OpenAI from "openai";

// ---------- CONFIG ----------
const KNOWN_ALLERGENS = ["eggs", "dairy", "peanuts", "tree_nuts", "shellfish", "soy"];
const SUPPORTED_LANGS = ["en", "fr", "es", "pt", "zh"];

// Optional: allow browser-based testing tools (Hoppscotch etc.)
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Helpers to keep things safe
function normalizeAllergensFromBody(body) {
  // 1) If we directly have "allergens" as array or string
  const direct = body?.allergens;

  // Accept array or comma-separated string
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

  // 2) Gather “checkbox per allergen” pattern:
  // e.g. allergens_eggs: "on", allergens_dairy: "on"
  const fields = body || {};
  const fromCheckboxes = Object.keys(fields)
    .filter(k => k.startsWith("allergens_") && fields[k]) // truthy means checked
    .map(k => k.replace("allergens_", "").toLowerCase());

  const cleanFromCheckboxes = fromCheckboxes
    .map(v => v.replace(/\s+/g, "_"))
    .filter(v => KNOWN_ALLERGENS.includes(v));

  return cleanFromCheckboxes;
}

function normalizeLanguage(lang) {
  const v = String(lang || "").trim().toLowerCase();
  return SUPPORTED_LANGS.includes(v) ? v : "en";
}

// Build a simple fallback card if OpenAI fails for any reason
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

// Ask OpenAI to produce a short, neat, translated card
async function generateCardWithAI({ name, allergens, contact_name, contact_phone, language }) {
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

  // Use a small-cheap model (adjust if needed)
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
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = port === 465; // true for 465, false for 587

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER, // for Brevo, this should be 'apikey'
      pass: process.env.SMTP_PASS, // for Brevo, this is your xkeysib_... API key
    },
  });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "POST only" });
    }

    const body = req.body || {};

    // Collect & normalize fields
    const clean = {
      email: String(body.email || "").trim(),
      name: String(body.name || "").trim(),
      contact_name: String(body.contact_name || "").trim(),
      contact_phone: String(body.contact_phone || "").trim(),
      language: normalizeLanguage(body.language),
      allergens: normalizeAllergensFromBody(body),
    };

    // Basic validation (return 400 instead of 500)
    if (!clean.email || !clean.name) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: name, email",
        received: { email: clean.email, name: clean.name },
      });
    }

    // Generate the card text with AI (fallback to simple if something goes wrong)
    let cardText;
    try {
      cardText = await generateCardWithAI(clean);
    } catch (e) {
      console.error("OpenAI failed, using fallback. Reason:", e?.message);
      cardText = fallbackCard(clean);
    }

    // Send email
    const transporter = buildTransporter();
    const subject = `Allergy Card for ${clean.name}`;
    const html = `
      <div style="font-family:system-ui,Arial,sans-serif;white-space:pre-wrap;line-height:1.45">
        ${cardText.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
      </div>
    `;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,   // must be a verified sender in Brevo
      to: clean.email,
      subject,
      text: cardText,
      html,
    });

    return res.status(200).json({ ok: true, emailed_to: clean.email });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
}
