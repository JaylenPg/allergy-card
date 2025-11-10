import sharp from "sharp";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { Resend } from "resend";

export const config = { runtime: "nodejs" };

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.EMAIL_FROM || "Jaylen <jaylen@onresend.com>";

const LANGS = {
  en: { template: "template-en.png", emergency: "Emergency Contact:", subject: "Your Allergy Card", emailLine: (n)=>`Hi ${n||"there"}, your allergy card is ready.` },
  fr: { template: "template-fr.png", emergency: "Contact d’urgence :", subject: "Votre carte d’allergies", emailLine: (n)=>`Bonjour ${n||""}, votre carte d’allergies est prête.` },
  es: { template: "template-es.png", emergency: "Contacto de emergencia:", subject: "Tu tarjeta de alergias", emailLine: (n)=>`Hola ${n||""}, tu tarjeta de alergias está lista.` },
  pt: { template: "template-pt.png", emergency: "Contacto de emergência:", subject: "Seu cartão de alergias", emailLine: (n)=>`Olá ${n||""}, seu cartão de alergias está pronto.` },
  zh: { template: "template-zh.png", emergency: "紧急联系人：", subject: "过敏卡已生成", emailLine: ()=>"您的过敏卡已生成。" }
};

const marks = {
  eggs:        { x: 170, y: 250 },
  dairy:       { x: 520, y: 250 },
  peanuts:     { x: 870, y: 250 },
  tree_nuts:   { x: 170, y: 380 },
  shellfish:   { x: 520, y: 380 },
  soy:         { x: 870, y: 380 }
};

function buildOverlaySVG({ width, height, name, allergens, emergencyText }) {
  const xs = Object.entries(marks).map(([key, pos]) => {
    if (!allergens.includes(key)) return "";
    return `<text x="${pos.x}" y="${pos.y}" font-family="Open Sans, Arial, sans-serif" font-weight="700" font-size="64" fill="#111">✖</text>`;
  }).join("");

  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <text x="${width/2}" y="95" text-anchor="middle"
            font-family="Open Sans, Arial, sans-serif"
            font-weight="700" font-size="72" fill="#111">
        ${String(name || "").toUpperCase()}
      </text>
      ${xs}
      <text x="125" y="${height - 45}"
            font-family="Open Sans, Arial, sans-serif"
            font-weight="700" font-size="40" fill="#ffffff">
        ${emergencyText}
      </text>
    </svg>
  `);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: "Missing RESEND_API_KEY env var" });
    if (!FROM_EMAIL) return res.status(500).json({ error: "Missing EMAIL_FROM env var" });

    let { email = "", name = "", allergens = [], contact_name = "", contact_phone = "", language = "en" } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing recipient email" });

    language = (language || "en").toLowerCase();
    const L = LANGS[language] ? language : "en";
    if (typeof allergens === "string") {
      allergens = allergens.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    }

    const tplUrl = new URL(`../assets/${LANGS[L].template}`, import.meta.url);
    const basePng = await readFile(tplUrl);
    const baseImg = sharp(basePng);
    const meta = await baseImg.metadata();
    const { width = 1024, height = 576 } = meta;

    const emergencyText = `${LANGS[L].emergency} ${contact_name} ${contact_phone}`;
    const overlay = buildOverlaySVG({ width, height, name, allergens, emergencyText });

    const pngBuffer = await baseImg
      .composite([{ input: overlay, top: 0, left: 0 }])
      .png()
      .toBuffer();

    const subject = LANGS[L].subject;
    const html = `
      <div style="font-family: Arial, sans-serif; line-height:1.45">
        <p>${LANGS[L].emailLine(name)}</p>
        <p>We’ve attached your PNG allergy card.</p>
      </div>
    `;

    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject,
      html,
      attachments: [
        { filename: \`allergy-card-\${L}.png\`, content: pngBuffer.toString("base64"), contentType: "image/png" }
      ]
    });

    console.log("DEBUG resend result:", { hasData: !!data, hasError: !!error, errorMessage: error?.message });

    if (error) {
      return res.status(500).json({ ok: false, source: "resend", message: error.message || String(error) });
    }

    return res.status(200).json({ ok: true, emailed_to: email, messageId: data?.id || null });

  } catch (e) {
    console.error("SERVER ERROR:", e?.stack || e?.message || e);
    return res.status(500).json({ ok: false, source: "server", message: e?.message || "Render or email failed" });
  }
}
