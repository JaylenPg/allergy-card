import { createCanvas, loadImage, registerFont } from "@napi-rs/canvas";
import { Resend } from "resend";

export const config = { runtime: "nodejs" };


// Email + optional image hosting
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.EMAIL_FROM || "no-reply@example.com";
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;          // optional
const UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;    // optional

// Use Open Sans (your files are in /assets)
registerFont("./assets/OpenSans-Bold.ttf", { family: "Open Sans", weight: "700" });
registerFont("./assets/OpenSans-Regular.ttf", { family: "Open Sans", weight: "400" });

// Language map (template image + label + email copy)
const LANGS = {
  en: {
    template: "./assets/template-en.png",
    emergency: "Emergency Contact:",
    subject: "Your Allergy Card",
    emailLine: (n) => `Hi ${n || "there"}, your allergy card is ready.`
  },
  fr: {
    template: "./assets/template-fr.png",
    emergency: "Contact d’urgence :",
    subject: "Votre carte d’allergies",
    emailLine: (n) => `Bonjour ${n || ""}, votre carte d’allergies est prête.`
  },
  es: {
    template: "./assets/template-es.png",
    emergency: "Contacto de emergencia:",
    subject: "Tu tarjeta de alergias",
    emailLine: (n) => `Hola ${n || ""}, tu tarjeta de alergias está lista.`
  },
  pt: {
    template: "./assets/template-pt.png",
    emergency: "Contacto de emergência:",
    subject: "Seu cartão de alergias",
    emailLine: (n) => `Olá ${n || ""}, seu cartão de alergias está pronto.`
  },
  zh: {
    template: "./assets/template-zh.png",
    emergency: "紧急联系人：",
    subject: "过敏卡已生成",
    emailLine: () => "您的过敏卡已生成。"
  }
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    // ---- 1) Read form data ----
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

    // ---- 2) Draw image from template ----
    const base = await loadImage(LANGS[L].template);
    const canvas = createCanvas(base.width, base.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(base, 0, 0);

    // Name (title)
    ctx.fillStyle = "#111";
    ctx.textAlign = "center";
    ctx.font = "700 72px Open Sans";
    ctx.fillText((name || "").toUpperCase(), base.width / 2, 95);

    // Allergen X marks (adjust x/y if needed to match your PNGs)
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

    // Red bar text — translated label + contact
    ctx.textAlign = "left";
    ctx.font = "700 40px Open Sans";
    ctx.fillStyle = "#fff";
    const emergency = LANGS[L].emergency;
    ctx.fillText(`${emergency} ${contact_name} ${contact_phone}`, 125, base.height - 45);

    const pngBuffer = canvas.toBuffer("image/png");

    // ---- 3) Optional: upload for a public URL (Cloudinary) ----
    let publicUrl = "";
    if (CLOUD_NAME && UPLOAD_PRESET) {
      const b64 = `data:image/png;base64,${pngBuffer.toString("base64")}`;
      const resp = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: b64, upload_preset: UPLOAD_PRESET })
      });
      const json = await resp.json();
      if (json.secure_url) publicUrl = json.secure_url;
    }

    // ---- 4) Email the user (Resend) ----
    const subject = LANGS[L].subject;
    const html = `
      <div style="font-family:'Open Sans',Arial,sans-serif;line-height:1.45">
        <p>${LANGS[L].emailLine(name)}</p>
        ${publicUrl ? `<p><a href="${publicUrl}">View / download the image</a></p>` : ""}
        <p>We've also attached the PNG.</p>
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
      url: publicUrl || null,
      messageId: emailResp?.id || null
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Render or email failed" });
  }
}


