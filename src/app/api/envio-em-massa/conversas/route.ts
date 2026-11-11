import { publishConversationEvent } from "@/server/realtime/conversation-events";
import { pendingRepliesQuery } from "@/modules/envio-em-massa/pending-replies";
import { isMp3Audio } from "@/lib/audio/mp3";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCurrentUser } from "@/lib/auth-context";
import { authErrorResponse } from "@/lib/api-errors";
import { successResponse, errorResponse } from "@/lib/api-response";
import { dispatchConversationScope, requireDispatchAdministrator } from "@/modules/envio-em-massa/conversation-access";
import { MetaWhatsappService } from "@/services/meta/meta-whatsapp.service";
import { MetaApiError } from "@/services/meta/meta.service";
import type { MetaConfig } from "@/services/meta/meta.service";
import { dispatchAccountIdFromMemory, getDispatchMetaConfig } from "@/modules/contas/accounts";

const whatsappService = new MetaWhatsappService();
const FREE_FORM_WINDOW_ERROR = "A Meta só permite texto livre, áudio, mídia ou documentos depois que o cliente responde e abre a janela de atendimento de 24 horas. Envie um template aprovado ou aguarde a resposta do cliente.";

const dispatchScope: Prisma.ChatConversationWhereInput = {
  deletedAt: null, memory: { path: ["source"], equals: "mass-message" },
};

export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser();
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    const search = params.get("search")?.trim() ?? "";
    const requestedLimit = Number(params.get("limit") ?? "100");
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100;
    let pending: Array<{ id: string; count: number }> | undefined;
    const where: Prisma.ChatConversationWhereInput = {
      ...dispatchConversationScope(user),
      ...(id ? { id } : {}),
    };
    if (id && !z.string().uuid().safeParse(id).success) return NextResponse.json(errorResponse("Conversa não encontrada."), { status: 404 });
    if (!id) {
      if (search) where.OR = [{ phone: { contains: search } }, { lead: { name: { contains: search, mode: "insensitive" } } }];
      const filter = params.get("filter");
      if (filter === "unread" || filter === "unanswered") {
        pending = await prisma.$queryRaw<Array<{ id: string; count: number }>>(pendingRepliesQuery(user));
        where.id = { in: pending.map((row) => row.id) };
      }
      if (filter === "open") where.state = { notIn: ["FINISHED", "BLOCKED"] };
      if (filter === "blocked") where.state = "BLOCKED";
    }
    const [conversations, total] = await Promise.all([prisma.chatConversation.findMany({
      where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: id ? 1 : limit,
      select: { id: true, memory: true, phone: true, ownerUserId: true, state: true, lead: { select: { name: true } }, owner: { select: { name: true } }, messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: id ? 100 : 1, select: { id: true, direction: true, body: true, createdAt: true } } },
    }), prisma.chatConversation.count({ where })]);
    if (id && !conversations.length) return NextResponse.json(errorResponse("Conversa não encontrada."), { status: 404 });
    pending ??= await prisma.$queryRaw<Array<{ id: string; count: number }>>(pendingRepliesQuery(user, conversations.map(item => item.id)));
    const pendingCounts = new Map(pending.map(item => [item.id, item.count]));
    const tagRecords = await prisma.appSetting.findMany({where:{key:{startsWith:"private:dispatch-tag:"}}});
    const catalog = tagRecords.map(record=>record.value as {id:string;label:string;color:string});
    const conversationsWithPending = conversations.map(({memory,...item}) => {
      const ids = (memory as {dispatchTagIds?:unknown})?.dispatchTagIds;
      return {...item, pendingReplyCount:pendingCounts.get(item.id)??0, tags:catalog.filter(tag=>Array.isArray(ids)&&ids.includes(tag.id)).map(({id,label,color})=>({id,label,color}))};
    });
    const employees = user.role === "ADMIN" ? await prisma.user.findMany({ where: { role: { in: ["EMPLOYEE", "ADMIN"] }, status: "ACTIVE", deletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [];
    return NextResponse.json(successResponse("Conversas consultadas.", { conversations: conversationsWithPending, employees, total, limit, hasMore: !id && conversations.length < total }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json(errorResponse("Não foi possível consultar as conversas."), { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireCurrentUser();
    const body = z.object({
      conversationId: z.string().uuid(),
      action: z.enum(["assign", "block", "unblock"]).default("assign"),
      ownerUserId: z.string().uuid().nullable().optional(),
    }).safeParse(await request.json());
    if (!body.success) return NextResponse.json(errorResponse("Dados inválidos."), { status: 400 });
    const { conversationId, action } = body.data;

    if (action === "block" || action === "unblock") {
      const count = (await prisma.chatConversation.updateMany({
        where: { ...dispatchConversationScope(user), id: conversationId },
        data: { state: action === "block" ? "BLOCKED" : "START" },
      })).count;
      if (!count) return NextResponse.json(errorResponse("Conversa não encontrada."), { status: 404 });
      await publishConversationEvent({ conversationId, type: "conversation_updated" });
      return NextResponse.json(successResponse(action === "block" ? "Contato bloqueado." : "Contato desbloqueado.", null));
    }

    requireDispatchAdministrator(user);
    const ownerUserId = body.data.ownerUserId ?? null;
    const count = await prisma.$transaction(async (tx) => {
      if (ownerUserId && !await tx.user.findFirst({ where: { id: ownerUserId, role: { in: ["EMPLOYEE", "ADMIN"] }, status: "ACTIVE", deletedAt: null } })) return -1;
      return (await tx.chatConversation.updateMany({ where: { ...dispatchScope, id: conversationId }, data: { ownerUserId } })).count;
    });
    if (count === -1) return NextResponse.json(errorResponse("Responsável indisponível."), { status: 400 });
    if (!count) return NextResponse.json(errorResponse("Conversa não encontrada."), { status: 404 });
    await publishConversationEvent({ conversationId, type: "assignment_updated" });
    return NextResponse.json(successResponse("Responsável atualizado.", null));
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json(errorResponse("Não foi possível atribuir o responsável."), { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireCurrentUser();
    const params = new URL(request.url).searchParams;
    const conversationId = params.get("id") ?? "";
    if (!z.string().uuid().safeParse(conversationId).success) return NextResponse.json(errorResponse("Conversa não encontrada."), { status: 404 });
    const count = (await prisma.chatConversation.updateMany({
      where: { ...dispatchConversationScope(user), id: conversationId },
      data: { deletedAt: new Date() },
    })).count;
    if (!count) return NextResponse.json(errorResponse("Conversa não encontrada."), { status: 404 });
    await publishConversationEvent({ conversationId, type: "conversation_deleted" });
    return NextResponse.json(successResponse("Conversa excluída.", null));
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json(errorResponse("Não foi possível excluir a conversa."), { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const conversationId = String(formData.get("conversationId") ?? "");
      const caption = String(formData.get("caption") ?? "").trim();
      const file = formData.get("file");
      if (!z.string().uuid().safeParse(conversationId).success || !(file instanceof File)) {
        return NextResponse.json(errorResponse("Arquivo ou conversa inválidos."), { status: 400 });
      }

      const conversation = await prisma.chatConversation.findFirst({
        where: { ...dispatchConversationScope(user), id: conversationId },
        select: { id: true, phone: true, state: true, memory: true },
      });
      if (!conversation) return NextResponse.json(errorResponse("Conversa não encontrada."), { status: 404 });
      if (conversation.state === "BLOCKED") return NextResponse.json(errorResponse("Contato bloqueado. Desbloqueie para enviar mensagens."), { status: 423 });
      if (!await hasOpenCustomerServiceWindow(conversation.id)) return NextResponse.json(errorResponse(FREE_FORM_WINDOW_ERROR), { status: 409 });

      if (file.size > 4 * 1024 * 1024) {
        return NextResponse.json(errorResponse("O arquivo deve ter no máximo 4 MB para envio pelo CRM."), { status: 413 });
      }
      const originalBuffer = Buffer.from(await file.arrayBuffer());
      const mimeType = normalizeUploadedMimeType(file.name, file.type || "application/octet-stream");
      const mediaKind = mediaKindFromMime(mimeType);
      if (mediaKind === "audio") {
        if (mimeType !== "audio/mpeg") {
          return NextResponse.json(errorResponse("Para garantir compatibilidade com a Meta, envie áudio somente em MP3."), { status: 415 });
        }
        if (!isMp3Audio(originalBuffer)) {
          return NextResponse.json(errorResponse("O arquivo não contém um MP3 válido. Grave novamente ou anexe um MP3 sem renomear outro formato."), { status: 400 });
        }
      }
      const media = { buffer: originalBuffer, mimeType, fileName: mediaKind === "audio" ? ensureMp3FileName(file.name) : file.name };
      const dataUrl = `data:${mimeType};base64,${media.buffer.toString("base64")}`;
      const replyThrough = new Date().toISOString();
      const config = await getDispatchMetaConfig(dispatchAccountIdFromMemory(conversation.memory));
      const providerId = await sendMediaToWhatsapp({
        phone: conversation.phone,
        kind: mediaKind,
        dataUrl,
        fileName: media.fileName,
        caption,
        config,
      });

      await prisma.$transaction([
        prisma.chatMessage.create({
          data: {
            conversationId: conversation.id,
            direction: "outbound",
            body: JSON.stringify({
              kind: "media",
              mediaKind,
              fileName: media.fileName,
              mimeType,
              dataUrl,
              caption,
            }),
            providerId,
            rawPayload: { kind: "manual-dispatch-media", mediaKind, fileName: media.fileName, mimeType, replyThrough },
            sentAt: new Date(),
          },
        }),
        prisma.chatConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }),
      ]);

      await publishConversationEvent({ conversationId: conversation.id, type: "outbound_message" });
      return NextResponse.json(successResponse("Arquivo enviado.", null));
    }

    const body = z.object({ conversationId: z.string().uuid(), content: z.string().trim().min(1) }).safeParse(await request.json());
    if (!body.success) return NextResponse.json(errorResponse("Mensagem inválida."), { status: 400 });

    const conversation = await prisma.chatConversation.findFirst({
      where: { ...dispatchConversationScope(user), id: body.data.conversationId },
      select: { id: true, phone: true, state: true, memory: true },
    });
    if (!conversation) return NextResponse.json(errorResponse("Conversa não encontrada."), { status: 404 });
    if (conversation.state === "BLOCKED") return NextResponse.json(errorResponse("Contato bloqueado. Desbloqueie para enviar mensagens."), { status: 423 });
    if (!await hasOpenCustomerServiceWindow(conversation.id)) return NextResponse.json(errorResponse(FREE_FORM_WINDOW_ERROR), { status: 409 });

    const replyThrough = new Date().toISOString();
    const config = await getDispatchMetaConfig(dispatchAccountIdFromMemory(conversation.memory));
    const providerId = await whatsappService.sendText({ phone: conversation.phone, message: body.data.content, config });
    await prisma.$transaction([
      prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          direction: "outbound",
          body: body.data.content,
          providerId,
          rawPayload: { kind: "manual-dispatch-text", replyThrough },
          sentAt: new Date(),
        },
      }),
      prisma.chatConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }),
    ]);

    await publishConversationEvent({ conversationId: conversation.id, type: "outbound_message" });
    return NextResponse.json(successResponse("Mensagem enviada.", null));
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    const status = error instanceof MetaApiError ? error.statusCode : 500;
    return NextResponse.json(errorResponse(error instanceof Error ? error.message : "Não foi possível enviar a mensagem."), { status });
  }
}

async function hasOpenCustomerServiceWindow(conversationId: string) {
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const inbound = await prisma.chatMessage.findFirst({
    where: { conversationId, direction: "inbound", createdAt: { gte: windowStart } },
    select: { id: true },
  });
  return Boolean(inbound);
}

function normalizeMimeType(mimeType: string) {
  return mimeType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function normalizeUploadedMimeType(fileName: string, mimeType: string) {
  const normalized = normalizeMimeType(mimeType);
  if (["audio/mpeg", "audio/mp3", "audio/x-mpeg"].includes(normalized) || fileName.toLowerCase().endsWith(".mp3")) return "audio/mpeg";
  return normalized;
}

function ensureMp3FileName(fileName: string) {
  return fileName.toLowerCase().endsWith(".mp3") ? fileName : `${fileName.replace(/\.[^.]+$/, "") || "audio"}.mp3`;
}

function mediaKindFromMime(mimeType: string): "image" | "video" | "audio" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

function sendMediaToWhatsapp(input: {
  phone: string;
  kind: "image" | "video" | "audio" | "document";
  dataUrl: string;
  fileName: string;
  caption?: string;
  config: MetaConfig;
}) {
  if (input.kind === "image") return whatsappService.sendImage({ phone: input.phone, image: input.dataUrl, caption: input.caption, config: input.config });
  if (input.kind === "video") return whatsappService.sendVideo({ phone: input.phone, video: input.dataUrl, caption: input.caption, config: input.config });
  if (input.kind === "audio") return whatsappService.sendAudio({ phone: input.phone, audio: input.dataUrl, config: input.config });
  return whatsappService.sendDocument({ phone: input.phone, document: input.dataUrl, fileName: input.fileName, caption: input.caption, config: input.config });
}
