import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { errorResponse, successResponse } from "@/lib/api-response";
import { writeTechnicalLog } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { ChatbotEngineService } from "@/modules/chatbot/services/chatbot-engine.service";
import { ChatbotRepository } from "@/repositories/chatbot.repository";
import { MetaWhatsappService } from "@/services/meta/meta-whatsapp.service";
import { OpenAiService, type ExtractedCustomerData } from "@/services/openai/openai.service";
import { recordDeliveryStatuses } from "@/modules/envio-em-massa/services/delivery-status.service";
import { getMetaConfigForPhoneNumber, listWebhookVerifyTokens } from "@/modules/contas/accounts";

const chatbotEngineService = new ChatbotEngineService();
const chatbotRepository = new ChatbotRepository();
const metaWhatsappService = new MetaWhatsappService();
const openAiService = new OpenAiService();

export const maxDuration = 120;

type MetaWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        contacts?: Array<{
          wa_id?: string;
          profile?: { name?: string };
        }>;
        messages?: MetaMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
};

type MetaMessage = {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string; sha256?: string };
  document?: { id?: string; mime_type?: string; caption?: string; filename?: string; sha256?: string };
  audio?: { id?: string; mime_type?: string; sha256?: string; voice?: boolean };
  video?: { id?: string; mime_type?: string; caption?: string; sha256?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  contacts?: Array<{ name?: { formatted_name?: string } }>;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const acceptedTokens = await listWebhookVerifyTokens();

  if (mode === "subscribe" && challenge && token && acceptedTokens.includes(token)) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(errorResponse("Token de verificação inválido.", "INVALID_WEBHOOK_TOKEN"), { status: 403 });
}

export async function POST(request: Request) {
  const debugRequested = request.headers.get("x-cris-debug") === "1";
  try {
    const rawPayload = (await request.json()) as MetaWebhookPayload;
    const events = flattenMessages(rawPayload);
    const recordedStatuses = await recordDeliveryStatuses(rawPayload);

    if (!events.length) {
      return NextResponse.json(successResponse("Confirmações recebidas.", { ignored: recordedStatuses === 0, recordedStatuses }));
    }

    const results = [];
    for (const event of events) {
      const senderKey = event.message.from ?? "unknown";
      const rateLimit = checkRateLimit(`meta:${event.phoneNumberId ?? "default"}:${senderKey}`, 120, 60_000);
      if (!rateLimit.allowed) {
        return NextResponse.json(errorResponse("Limite de webhooks excedido.", "RATE_LIMITED"), { status: 429 });
      }

      const eventConfig = await getMetaConfigForPhoneNumber(event.phoneNumberId);
      const incoming = await extractIncomingMessage(event.message, eventConfig);
      if (!event.message.from || !incoming.message) {
        results.push({ ignored: true, reason: "invalid-message" });
        continue;
      }

      const dispatchConversation = await findDispatchConversation(event.message.from, event.phoneNumberId);
      if (dispatchConversation) {
        const dispatchIncoming = await extractDispatchIncomingMessage(event.message, incoming.message, eventConfig);
        if (event.message.id) {
          const claimed = await chatbotRepository.claimInboundMessage({
            conversationId: dispatchConversation.id,
            body: dispatchIncoming.body,
            providerId: event.message.id,
            rawPayload: rawPayload as Prisma.InputJsonValue,
          });
          if (claimed) await metaWhatsappService.markAsRead(event.message.id, eventConfig);
          results.push({ state: "DISPATCH_INBOX", replied: false, duplicated: !claimed });
        } else {
          await chatbotRepository.saveMessage({
            conversationId: dispatchConversation.id,
            direction: "inbound",
            body: dispatchIncoming.body,
            rawPayload: rawPayload as Prisma.InputJsonValue,
          });
          results.push({ state: "DISPATCH_INBOX", replied: false });
        }
        continue;
      }

      const result = await chatbotEngineService.processIncomingMessage({
        phone: event.message.from,
        message: incoming.message,
        providerId: event.message.id,
        rawPayload: rawPayload as Prisma.InputJsonValue,
        instanceId: event.phoneNumberId,
        extractedData: incoming.extractedData,
      });
      results.push(result);
    }

    return NextResponse.json(successResponse("Webhook da Meta processado.", { results }));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown";
    await writeTechnicalLog({
      level: "ERROR",
      category: "webhook",
      message: "Falha ao processar webhook da Meta.",
      method: "POST",
      endpoint: "/api/webhooks/meta",
      integration: "meta",
      metadata: { error: errorMessage },
    });
    const response = errorResponse("Nao foi possivel processar o webhook.");
    if (debugRequested) {
      return NextResponse.json({ ...response, details: errorMessage }, { status: 500 });
    }
    return NextResponse.json(response, { status: 500 });
  }
}

function flattenMessages(payload: MetaWebhookPayload) {
  const events: Array<{ phoneNumberId?: string; message: MetaMessage }> = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      for (const message of change.value?.messages ?? []) {
        events.push({ phoneNumberId, message });
      }
    }
  }
  return events;
}

async function extractIncomingMessage(message: MetaMessage, config?: import("@/services/meta/meta.service").MetaConfig | null): Promise<{ message: string; extractedData?: ExtractedCustomerData }> {
  const text = (
    message.text?.body ??
    message.button?.text ??
    message.button?.payload ??
    message.interactive?.button_reply?.title ??
    message.interactive?.button_reply?.id ??
    message.interactive?.list_reply?.title ??
    message.interactive?.list_reply?.description ??
    message.interactive?.list_reply?.id ??
    message.contacts?.[0]?.name?.formatted_name ??
    ""
  ).trim();
  if (text) return { message: text };

  if (message.audio?.id) {
    try {
      const media = await metaWhatsappService.downloadMediaAsDataUrl(message.audio.id, config);
      const transcription = await openAiService.transcribeAudio({
        url: media.dataUrl,
        mimeType: media.mimeType,
      });
      if (transcription) return { message: transcription };
    } catch {
      return { message: "[Áudio não pôde ser transcrito]", extractedData: {} };
    }
  }

  const mediaId = message.image?.id ?? message.document?.id ?? message.video?.id;
  const mediaMime = message.image?.mime_type ?? message.document?.mime_type ?? message.video?.mime_type;
  const mediaLabel = message.image?.id ? "Imagem" : message.document?.id ? "Documento" : message.video?.id ? "Vídeo" : "Mídia";
  const caption = message.image?.caption ?? message.document?.caption ?? message.video?.caption;

  if (mediaId) {
    if (caption?.trim()) return { message: caption.trim() };
    try {
      const media = await metaWhatsappService.downloadMediaAsDataUrl(mediaId, config);
      if (media.mimeType.startsWith("image/") || media.mimeType === "application/pdf" || mediaMime === "application/pdf") {
        const extractedData = await openAiService.extractCustomerData({
          url: media.dataUrl,
          mimeType: media.mimeType,
        });
        return { message: `[${mediaLabel} recebido]`, extractedData };
      }
    } catch {
      return { message: `[${mediaLabel} não pôde ser lido]`, extractedData: {} };
    }
    return { message: `[${mediaLabel} recebido]`, extractedData: {} };
  }

  if (message.location && Number.isFinite(message.location.latitude) && Number.isFinite(message.location.longitude)) {
    return {
      message: "[Localização recebida]",
      extractedData: {
        address: [message.location.name, message.location.address].filter(Boolean).join(" - ") || undefined,
      },
    };
  }

  return { message: "" };
}

async function findDispatchConversation(phone: string, phoneNumberId?: string) {
  if (!phoneNumberId || !/^\d+$/.test(phoneNumberId)) return null;
  const normalizedPhone = phone.replace(/\D/g, "");
  if (!normalizedPhone) return null;
  const candidates = await prisma.chatConversation.findMany({
    where: {
      phone: normalizedPhone,
      deletedAt: null,
      memory: { path: ["source"], equals: "mass-message" },
    },
    select: { id: true, memory: true },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const dispatchConversation = candidates.find(conversation => {
    const memory = conversation.memory && typeof conversation.memory === "object" && !Array.isArray(conversation.memory) ? conversation.memory as Record<string, unknown> : {};
    const senderIds = Array.isArray(memory.dispatchSenderIds) ? memory.dispatchSenderIds : [];
    return senderIds.includes(phoneNumberId) || memory.dispatchLastSenderId === phoneNumberId || (!senderIds.length && phoneNumberId === process.env.META_WHATSAPP_PHONE_NUMBER_ID?.trim());
  });
  if (!dispatchConversation) return null;
  const memory = dispatchConversation.memory && typeof dispatchConversation.memory === "object" && !Array.isArray(dispatchConversation.memory) ? dispatchConversation.memory as Record<string, unknown> : {};
  const senderIds = Array.isArray(memory.dispatchSenderIds) ? memory.dispatchSenderIds.filter((id): id is string => typeof id === "string") : [];
  await prisma.chatConversation.update({
    where: { id: dispatchConversation.id },
    data: { memory: { ...memory, source: "mass-message", dispatchSenderIds: [...new Set([...senderIds, phoneNumberId])], dispatchLastSenderId: phoneNumberId } as Prisma.InputJsonValue },
  });
  return dispatchConversation;
}

async function extractDispatchIncomingMessage(message: MetaMessage, fallbackText: string, config?: import("@/services/meta/meta.service").MetaConfig | null) {
  const audioId = message.audio?.id;
  if (audioId) {
    return mediaBodyFromMeta({
      mediaId: audioId,
      mediaKind: "audio",
      mimeType: message.audio?.mime_type,
      fileName: `audio-${message.id ?? Date.now()}.ogg`,
      caption: "",
    }, config);
  }

  const mediaId = message.image?.id ?? message.document?.id ?? message.video?.id;
  if (!mediaId) return { body: fallbackText };

  const mediaKind = message.image?.id ? "image" : message.video?.id ? "video" : "document";
  return mediaBodyFromMeta({
    mediaId,
    mediaKind,
    mimeType: message.image?.mime_type ?? message.document?.mime_type ?? message.video?.mime_type,
    fileName: message.document?.filename ?? `${mediaKind}-${message.id ?? Date.now()}`,
    caption: message.image?.caption ?? message.document?.caption ?? message.video?.caption ?? "",
  }, config);
}

async function mediaBodyFromMeta(input: {
  mediaId: string;
  mediaKind: "image" | "video" | "audio" | "document";
  mimeType?: string;
  fileName: string;
  caption?: string;
}, config?: import("@/services/meta/meta.service").MetaConfig | null) {
  try {
    const media = await metaWhatsappService.downloadMediaAsDataUrl(input.mediaId, config);
    return {
      body: JSON.stringify({
        kind: "media",
        mediaKind: input.mediaKind,
        fileName: input.fileName,
        mimeType: media.mimeType || input.mimeType || "application/octet-stream",
        dataUrl: media.dataUrl,
        caption: input.caption?.trim() ?? "",
      }),
    };
  } catch {
    const label = input.mediaKind === "image" ? "Imagem" : input.mediaKind === "video" ? "Vídeo" : input.mediaKind === "audio" ? "Áudio" : "Documento";
    return { body: input.caption?.trim() || `[${label} recebido, mas não pôde ser baixado]` };
  }
}
