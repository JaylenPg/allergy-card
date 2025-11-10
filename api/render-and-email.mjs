import { createCanvas, loadImage, registerFont } from "@napi-rs/canvas";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { Resend } from "resend";

export const config = { runtime: "nodejs" };

// ---- env + client ----
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.EMAIL_FROM || "Jaylen <jaylen@onresend.com>";

// ---- language map (filenames only) ----
const LANGS = {
  en: {
    template: "template-en.png",
    emergency: "Emergency Contact:",
    subject: "Your Allergy Card",
    emailLine: (n) => `Hi ${n || "there"}, your allergy card is ready.`
  },
  fr: {
    template: "template-fr.png",
    emergency: "Contact d’urgence :",
    subject: "Votre carte d’allergies",
    emailLine: (n) => `Bonjour ${n || ""}, votre carte d’allergies est prête.`
  },
  es: {
    template: "template-es.png",
    emergency: "Contacto de emergencia:",
    subject: "Tu tarjeta de alergias",
    emailLine: (n) => `Hola ${n || ""}, tu tarjeta de alergias está lista.`
  },
  pt: {
    template: "template-pt.png",
    emergency: "Contacto de emergência:",
    subject: "Seu cartão de alergias",
    emailLine: (n) => `Olá ${n || ""}, seu cartão de alergias está pronto.`
  },
  zh: {
    template: "template-zh.png",
    emergency: "紧急联系人：",
    subject: "过敏卡已生成",
    emailLine: () => "您的过敏卡已生成。"
  }
};

// ---- absolute paths to assets (works on Vercel) ----
const fontBoldPath = fileURLToPath(new URL("../assets/OpenSans-Bold.ttf", import.meta.url));
const fontRegPath  = fileURLToPath(new URL("../assets/OpenSans-Regular.ttf", import.meta.url));
registerFont(fontBoldPath, { family: "Open Sans", weight: "700" });
registerFont(fontRegPath,  { family: "Open Sans", weight: "400" });

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "POST only" });
    }
    // ---- validate env ----
    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({ error: "Missing RESEND_API_KEY env var" });
    }
    if (!FROM_EMAIL) {
      return res.status(500).json({ error: "Missing EMAIL_FROM env var" });
    }

    // ---- read input ----
    let {
      email = "",
      name = "",
      allergens = [],
      contact_name = "",
      contact_phone = "",
      language = "en"
    } = req.body || {};

    if (!email) return res.status(400).json({ error: "Missing recipient email" });

    language = (language || "en").toLowerCase();
    const L = LANGS[language] ? language : "en";

    if (typeof allergens === "string") {
      allergens = allergens.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    }

    // ---- load template image from /assets using absolute URL ----
    const tplUrl = new URL(`../assets/${LANGS[L].template}`, import.meta.url);
    const baseBytes = await readFile(tplUrl);
    const baseImg = await loadImage(baseBytes);

    // ---- draw canvas ----
    const canvas = createCanvas(baseImg.width, baseImg.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(baseImg, 0, 0);

    // Name
    ctx.fillStyle = "#111";
    ctx.textAlign = "center";
    ctx.font = "700 72px Open Sans";
    ctx.fillText((name || "").toUpperCase(), baseImg.width / 2, 95);

    // X marks
    const marks = {
      eggs:        { x: 170, y: 250 },
      dairy:       { x: 520, y: 250 },
      peanuts:     { x: 870, y: 250 },
      tree_nuts:   { x: 170, y: 380 },
      shellfish:   { x: 520, y: 380 },
      soy:         { x: 870, y: 380 }
    };
    ctx.font = "700 64px Open Sans";
    for (const key of Object.keys(marks)) {
      if (allergens.includes(key)) {
        const { x, y } = marks[key];
        ctx.fillText("✖", x, y);
      }
    }

    // Emergency bar text
    ctx.textAlign = "left";
    ctx.font = "700 40px Open Sans";
    ctx.fillStyle = "#fff";
    ctx.fillText(`${LANGS[L].emergency} ${contact_name} ${contact_phone}`, 125, baseImg.height - 45);

    const pngBuffer = canvas.toBuffer("image/png");

    // ---- send email ----
    const subject = LANGS[L].subject;
    const html = `
      <div style="font-family:'Open Sans',Arial,sans-serif;line-height:1.45">
        <p>${LANGS[L].emailLine(name)}</p>
        <p>We’ve attached your PNG allergy card.</p>
      </div>
    `;

    const emailResp = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject,
      html,
      attachments: [
        {
          filename: `allergy-card-${L}.png`,
          content: pngBuffer.toString("base64"),
          contentType: "image/png"
        }
      ]
    });

    return res.status(200).json({
      ok: true,
      emailed_to: email,
      messageId: emailResp?.id || null
    });

  } catch (e) {
    console.error("SERVER ERROR:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "Render or email failed" });
  }
}
