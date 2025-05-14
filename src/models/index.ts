export type MessageSource = "telegram" | "whatsapp" | "instagram" | "widget";
export type MessageType = "text" | "image" | "voice" | "audio";
export type ResponseMode = "manual" | "auto";

export interface Message {
  id?: string;
  platformMessageId?: string;
  source: MessageSource;
  chatId: string;
  type: MessageType;
  content: string;
  mediaFileId?: string;
  isIncoming: boolean;
  timestamp: Date;
  senderId: string;
  senderName?: string;
  responseMode: ResponseMode;
}

export interface Chat {
  id?: string;
  platformChatId?: string;
  source: MessageSource;
  name: string;
  updated: Date;
  autoMode: boolean;
  openAIThreadId?: string;
}