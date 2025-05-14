import { ConversationsApi, ConversationsApiApiKeys } from '@getbrevo/brevo';
import { Message, MessageSource, MessageType } from '../models';
import { findOrCreateChat, saveMediaFile, saveMessage } from "../storage/pocketbase";
import { getAIResponse } from "../responder/openai";
import dotenv from 'dotenv';

dotenv.config();

const apiInstance = new ConversationsApi();
apiInstance.setApiKey(ConversationsApiApiKeys.apiKey, process.env.BREVO_API_KEY!);
const BREVO_AGENT_ID = process.env.BREVO_AGENT_ID;


export async function processAgentMessage(body: any) {
  const message = body.message || body.messages[0];
  if (message.agentId && message.agentId.includes('Dummy')) {
    console.log(`Skipping Instagram duplicate message with ID: ${message.id}`);
    return;
  }
  let platform = body.visitor.source
  if (platform === "widget") {
    platform = "instagram";
  }

  await processBrevoMessage(body.visitor, message, platform, false);
}

export async function processBrevoMessage(visitor: any, message: any, platform: string, isIncoming: boolean) {
  try {
    const chat = await findOrCreateChat(
      visitor.threadId,
      platform as MessageSource,
      visitor.displayedName
    );

    if (!chat || !chat.id) {
      console.error(`Failed to create/get chat for visitor: ${visitor.id}`);
      return;
    }

    let msgType: MessageType = "text";
    let content = message.text || "";
    let mediaFileId: string | undefined;

    if (message.file) {
      if (message.file.isImage) {
        msgType = "image";
        if (message.file.link) {
          try {
            const response = await fetch(message.file.link);
            if (response.ok) {
              const blob = await response.blob();
              mediaFileId = await saveMediaFile(
                blob,
                `brevo_${platform}_${message.id}.jpg`,
                "image/jpeg",
                platform as MessageSource
              );
            }
          } catch (error) {
            console.error("Error downloading image:", error);
          }
        }
      } else {
        msgType = "audio";
        if (message.file.link) {
          try {
            const response = await fetch(message.file.link);
            if (response.ok) {
              const blob = await response.blob();
              mediaFileId = await saveMediaFile(
                blob,
                `brevo_${platform}_${message.id}.mp4`,
                "audio/mp4",
                platform as MessageSource
              );
            }
          } catch (error) {
            console.error("Error downloading audio:", error);
          }
        }
      }
    }

    const msg: Message = {
      source: platform as MessageSource,
      platformMessageId: message.id,
      chatId: chat.id,
      type: msgType,
      content: content,
      mediaFileId: mediaFileId || undefined,
      isIncoming: isIncoming,
      timestamp: new Date(message.createdAt),
      senderId: isIncoming ? visitor.id : message.agentId || process.env.OPENAI_ASSISTANT_ID!,
      senderName: isIncoming ? visitor.displayedName : message.agentName || "OpenAI Assistant",
      responseMode: isIncoming ? "manual" : "auto"
    };

    await saveMessage(msg);

    if (!isIncoming) {
      return;
    }

    if (chat.autoMode && isIncoming) {
      console.log(`Generating auto-reply for message: ${message.id}`);
      const res = await getAIResponse(msg, chat.openAIThreadId!);

      await sendBrevoMessage(visitor.id, res);
    }
  } catch (error) {
    console.error("Error processing Brevo message:", error);
  }
}

export async function sendBrevoMessage(visitorId: string, text: string): Promise<string | null> {
  try {
    const payload = {
      "visitorId": visitorId,
      "text": text,
      "agentId": BREVO_AGENT_ID
    };

    const response = await apiInstance.conversationsMessagesPost(payload);
    return response.body.id!;

  } catch (error) {
    console.error("Error sending Brevo message:", error);
    return null;
  }
}
