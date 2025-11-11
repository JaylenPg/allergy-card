import { readFile } from "fs/promises";
import nodemailer from "nodemailer";

export const config = { runtime: "nodejs" };

// language map (template filenames + strings)
const LANGS = {
  en: { template: "template-en.png", emergency: "Emergency Contact:", subject: "Your Allergy Card", emailLine: (n)=>`Hi ${n||"there"}, your allergy card is ready.` },
  fr: { template: "template-fr.png", emergency: "Contact d’urgence :", subject: "Votre carte d’allergies", emailLine: (n)=>`Bonjour ${n||""}, votre carte d’allergies est prête.` },
  es: { template: "template-es.png", emergency: "Contacto de emergencia:", subject: "Tu tarjeta de alergias", emailLine: (n)=>`Hola ${n||""}, tu tarjeta de alergias está lista.` },
  pt: { template: "template-pt.png", emergency: "Contacto de emergência:", subject: "Seu cartão de alergias", emailLine: (n)=>`Olá ${n||""}, seu cartão de alergias está pronto.` },
  zh: { template: "template-zh.png", emergency: "紧急联系人：", subject: "过敏卡已生成", emailLine: ()=>"您的过敏卡已生成。" }
};

// X mark positions (adjust if needed to match your PNGs)
const marks = {
  eggs:        { x: 170, y: 250 },
  dairy:       { x: 520, y: 250 },
  peanuts:     { x: 870, y: 250 },
  tree_nuts:   { x: 170, y: 380 },
  shellfish:   { x: 520, y: 380 },
  soy:         { x: 870, y: 380 }
};

function buildOverlaySVG({ width, height, name, allergens, emergencyText }) {
  const xs = Object.entries(marks).map(([k, p]) =>
    allergens.includes(k)
      ? `<text x="${p.x}" y="${p.y}" font-family="Arial, sans-serif" font-weight="700" font-size="64" fill="#111">✖</text>`
      : ""
  ).join("");

  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="${width/2}" y="95" text-anchor="middle"
            font-family="Arial, sans-serif" font-weight="700" font-size="72" fill="#111">
        ${String(name||"").toUpperCase()}
      </text>
      ${xs}
      <text x="125" y="${height-45}"
            font-family="Arial, sans-serif"
            font-weight="700" font-size="40" fill="#fff">
        ${emergencyText}
      </text>
    </svg>
  `);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const SMTP_HOST = process.env.SMTP_HOST;
    const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const EMAIL_FROM = process.env.EMAIL_FROM;

    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM) {
      return res.status(500).json({ ok:false, message:"Missing SMTP env vars" });
    }

    let { email="", name="", allergens=[], contact_name="", contact_phone="", language="en" } = req.body || {};
    if (!email) return res.status(400).json({ ok:false, message:"Missing recipient email" });

    const L = LANGS[(language||"en").toLowerCase()] ? (language||"en").toLowerCase() : "en";
    const list = Array.isArray(allergens)
      ? allergens
      : String(allergens).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

    // Load base PNG from /assets
    const tplUrl = new URL(`../assets/${LANGS[L].template}`, import.meta.url);
    const basePng = await readFile(tplUrl);

    // Read PNG width/height from header (IHDR) to size overlay
    const width = basePng.readUInt32BE(16);
    const height = basePng.readUInt32BE(20);

    // Build overlay SVG
    const emergencyText = `${LANGS[L].emergency} ${contact_name} ${contact_phone}`;
    const overlay = buildOverlaySVG({ width, height, name, allergens: list, emergencyText });

    // Send via Brevo SMTP (Nodemailer)
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    const subject = LANGS[L].subject;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.45">
        <p>${LANGS[L].emailLine(name)}</p>
        <p>Attached: the base PNG template and the overlay SVG with your details.</p>
      </div>
    `;

    const info = await transporter.sendMail({
      from: EMAIL_FROM,
      to: email,
      subject,
      html,
      attachments: [
        { filename: `template-${L}.png`, content: basePng, contentType: "image/png" },
        { filename: `overlay-${L}.svg`, content: overlay, contentType: "image/svg+xml" }
      ]
    });

    return res.status(200).json({ ok:true, emailed_to: email, messageId: info?.messageId || null });
  } catch (e) {
    return res.status(500).json({ ok:false, message: e?.message || "failed" });
  }
}
