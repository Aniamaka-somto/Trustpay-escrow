import express from "express";
import { handleMessage } from "../bot/stateMachine.js";
import logger from "../utils/logger.js";

const router = express.Router();

router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info("WhatsApp webhook verified by Meta");
    return res.status(200).send(challenge);
  }

  logger.warn("WhatsApp webhook verification failed");
  res.sendStatus(403);
});

router.post("/", async (req, res) => {
  console.log("=== WEBHOOK HIT ===", JSON.stringify(req.body));
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    console.log("=== MESSAGES EXTRACTED ===", JSON.stringify(messages));
    if (!messages?.length) {
      console.log("=== NO MESSAGES, RETURNING ===");
      return;
    }

    for (const message of messages) {
      const phone = message.from;
      const type = message.type;

      console.log("=== PROCESSING ===", phone, type);

      let text = null;
      let mediaId = null;

      switch (type) {
        case "text":
          text = message.text?.body;
          break;
        case "image":
        case "document":
        case "video":
          mediaId = message[type]?.id;
          text = message[type]?.caption || "";
          break;
        case "interactive":
          text =
            message.interactive?.button_reply?.title ||
            message.interactive?.list_reply?.title;
          break;
        default:
          console.log("=== UNHANDLED TYPE ===", type);
          continue;
      }

      console.log("=== CALLING HANDLE MESSAGE ===", phone, text);
      await handleMessage(phone, text, type, mediaId);
      console.log("=== HANDLE MESSAGE DONE ===");
    }
  } catch (err) {
    console.log("=== WEBHOOK ERROR ===", err.message, err.stack);
  }
});

export default router;
