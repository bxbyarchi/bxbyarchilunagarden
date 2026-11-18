import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { parseWebhook, verifySignature, splitText } from "../lib/channels/meta";

const wa = (messages: unknown[]) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PN" }, contacts: [{ wa_id: "996700112233", profile: { name: "Нурлан" } }], messages } }] }],
});

describe("Meta webhooks", () => {
  it("reads WhatsApp text, buttons and media, skips statuses", () => {
    const ev = parseWebhook(wa([
      { from: "996700112233", id: "wamid.1", type: "text", text: { body: "Столик на 4 в пятницу?" } },
      { from: "996700112233", id: "wamid.2", type: "interactive", interactive: { button_reply: { title: "Да" } } },
      { from: "996700112233", id: "wamid.3", type: "audio" },
      { from: "996700112233", id: "wamid.4", type: "image", image: { caption: "вот меню" } },
    ]));
    expect(ev).toEqual([
      { channel: "whatsapp", from: "996700112233", name: "Нурлан", messageId: "wamid.1", text: "Столик на 4 в пятницу?", echo: false },
      { channel: "whatsapp", from: "996700112233", name: "Нурлан", messageId: "wamid.2", text: "Да", echo: false },
      { channel: "whatsapp", from: "996700112233", name: "Нурлан", messageId: "wamid.3", text: "[Гость прислал голосовое сообщение]", echo: false },
      { channel: "whatsapp", from: "996700112233", name: "Нурлан", messageId: "wamid.4", text: "[Гость прислал фото] вот меню", echo: false },
    ]);
    const statuses = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.1", status: "read" }] } }] }] };
    expect(parseWebhook(statuses)).toEqual([]);
  });

  it("reads Instagram DMs and recognises echoes of our own account", () => {
    const body = { object: "instagram", entry: [{ id: "IG_OWN", messaging: [
      { sender: { id: "GUEST1" }, recipient: { id: "IG_OWN" }, message: { mid: "m1", text: "Здравствуйте, вы работаете сегодня?" } },
      { sender: { id: "IG_OWN" }, recipient: { id: "GUEST1" }, message: { mid: "m2", text: "Да, до 24:00", is_echo: true } },
      { sender: { id: "GUEST1" }, recipient: { id: "IG_OWN" }, message: { mid: "m3", attachments: [{ type: "image" }] } },
      { sender: { id: "GUEST1" }, recipient: { id: "IG_OWN" }, read: { mid: "m2" } },
    ] }] };
    expect(parseWebhook(body, "IG_OWN")).toEqual([
      { channel: "instagram", from: "GUEST1", name: null, messageId: "m1", text: "Здравствуйте, вы работаете сегодня?", echo: false },
      { channel: "instagram", from: "GUEST1", name: null, messageId: "m2", text: "Да, до 24:00", echo: true },
      { channel: "instagram", from: "GUEST1", name: null, messageId: "m3", text: "[Гость прислал фото]", echo: false },
    ]);
  });

  it("checks Meta's signature", () => {
    const raw = Buffer.from(JSON.stringify(wa([])));
    const sig = "sha256=" + createHmac("sha256", "secret").update(raw).digest("hex");
    expect(verifySignature(raw, sig, "secret")).toBe(true);
    expect(verifySignature(raw, sig, "other")).toBe(false);
    expect(verifySignature(Buffer.from("tampered"), sig, "secret")).toBe(false);
    expect(verifySignature(raw, undefined, "secret")).toBe(false);
    expect(verifySignature(raw, sig, undefined)).toBe(false);
  });

  it("splits long replies on line breaks", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Строка ${i} ${"слово ".repeat(10)}`).join("\n");
    const parts = splitText(text, 300);
    expect(parts.every((p) => p.length <= 300)).toBe(true);
    expect(parts.join("\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
  });
});
