import OpenAI from "openai";
import nodemailer from "nodemailer";

export const config = { runtime: "nodejs" };

// languages you'll accept from the form
const SUPPORTED = new Set(["en", "fr", "es", "pt", "zh"]);

function buildPrompt({ language, name, allergens, contact_name, contact_phone }) {
  const lang = SUPPORTED.has((language || "").toLowerCase()) ? language.toLowerCase() : "en";
  const list = Array.isArray(allergens)
    ? allergens
    : String(allergens || "").split(",").map(s => s.trim()).filter(Boolean);

  return `
Write a 4-line "allergy card" in ${lang}. Use short, clear, polite language. No emojis.
Format with **bold** for the name and the "Emergency Contact" label.

Lines to include (exactly these ideas):
1) **${name || "Name not provided"}**
2) A sentence: "I am severely allergic to: ${list.length ? list.join(", ") : "several foods"}."
3) A sentence: "Do not feed me foods containing these allergens."
4) **Emergency Contact:** ${contact_name || "N/A"} — ${contact_phone || "N/A"}

If allergens are English, translate the food names naturally into ${lang}.
Return only the final card (no extra commentary).
`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    // env vars
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SMTP_HOST = process.env.SMTP_HOST;
    const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const EMAIL_FROM = process.env.EMAIL_FROM;

    if (!OPENAI_API_KEY) return res.status(500).json({ ok: false, message: "Missing OPENAI_API_KEY" });
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM) {
      return res.status(500).json({ ok: false, message: "Missing SMTP env vars" });
    }

    // request body
    let {
      email = "",
      name = "",
      allergens = [],
      contact_name = "",
      contact_phone = "",
      language = "en"
    } = req.body || {};

    if (!email) return res.status(400).json({ ok: false, message: "Missing recipient email" });

    // --- AI: write/translate the allergy card text ---
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const prompt = buildPrompt({ language, name, allergens, contact_name, contact_phone });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    });

    const cardText =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Allergy card could not be generated.";

    // --- Email via Brevo SMTP (Nodemailer) ---
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false, // STARTTLS on 587
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    const subjectMap = {
      en: "Your Allergy Card",
      fr: "Votre carte d’allergies",
      es: "Tu tarjeta de alergias",
      pt: "Seu cartão de alergias",
      zh: "您的过敏卡"
    };
    const L = SUPPORTED.has((language || "").toLowerCase()) ? language.toLowerCase() : "en";
    const subject = subjectMap[L] || subjectMap.en;

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5">
        <p>Here is your AI-generated allergy card:</p>
        <pre style="white-space:pre-wrap;font-family:inherit;background:#f6f7f9;padding:12px;border-radius:8px">${cardText}</pre>
        <p style="margin-top:14px;color:#666">Tip: save this to Notes or print it to keep on hand.</p>
      </div>
    `;

    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to: email,
      subject,
      html
    });

    return res.status(200).json({ ok: true, emailed_to: email, messageId: info?.messageId || null });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message || "Server error" });
  }
}
