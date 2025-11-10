import { Resend } from "resend";
export const config = { runtime: "nodejs" };

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.EMAIL_FROM || "Jaylen <jaylen@onresend.com>";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    const { email = "" } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing recipient email" });

    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: "Resend test from allergy-card",
      text: "If you received this, Resend is working. Next we re-enable image attachment."
    });

    if (error) return res.status(500).json({ ok: false, source: "resend", message: error.message });
    return res.status(200).json({ ok: true, messageId: data?.id || null });
  } catch (e) {
    return res.status(500).json({ ok: false, source: "server", message: e?.message || "failed" });
  }
}
