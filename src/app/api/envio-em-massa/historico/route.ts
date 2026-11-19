import { privateJsonResponse } from "@/lib/private-json-response";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCurrentUser } from "@/lib/auth-context";
import { authErrorResponse } from "@/lib/api-errors";
import { successResponse, errorResponse } from "@/lib/api-response";
import { applyDeliveryEvents, type DeliveryEvent, type HistoryContact } from "@/modules/envio-em-massa/delivery-status";
import type { DispatchHistoryEntry } from "@/modules/envio-em-massa/dispatch-history";
import type { Prisma } from "@prisma/client";

type StoredBatch = {
  userId?: string; title?: string; mode?: string; message?: string; startedAt?: string; isTest?: boolean;
  total: number; accepted: number; failed: number; uncertain: number;
  contacts?: Array<Omit<HistoryContact, "whatsapp">>;
};
export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser();
    const rawOffset = Number(new URL(request.url).searchParams.get("offset") ?? "0");
    const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const where: Prisma.AppSettingWhereInput = {
      key: { startsWith: "private:dispatch-result:" },
      ...(user.role === "ADMIN" ? {} : { value: { path: ["userId"], equals: user.id } }),
    };
    const [batches, total] = await Promise.all([
      prisma.appSetting.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: offset, take: 20 }),
      prisma.appSetting.count({ where }),
    ]);
    const ids = batches.map(batch => batch.key.slice("private:dispatch-result:".length));
    const messages = ids.length ? await prisma.chatMessage.findMany({
      where: { direction: "outbound", OR: ids.map(id => ({ rawPayload: { path: ["batchId"], equals: id } })) },
      select: { providerId: true, rawPayload: true, body: true, createdAt: true,
        conversation: { select: { phone: true, messages: { where: { direction: "inbound" }, take: 1, select: { id: true } } } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }) : [];
    const providerIds = [...new Set([
      ...messages.flatMap(message => message.providerId ? [message.providerId] : []),
      ...batches.flatMap(batch => ((batch.value as unknown as StoredBatch).contacts ?? []).flatMap(contact => contact.providerMessageId ? [contact.providerMessageId] : [])),
    ])];
    const statusRecords = providerIds.length ? await prisma.appSetting.findMany({ where: { key: { in: providerIds.flatMap(id => ["sent", "delivered", "read", "failed"].map(status => `private:dispatch-status:${id}:${status}`)) } }, select: { value: true } }) : [];
    const events = statusRecords.map(record => record.value as unknown as DeliveryEvent);
    const ownerIds = [...new Set(batches.flatMap(batch => (batch.value as unknown as StoredBatch).userId ? [(batch.value as unknown as StoredBatch).userId!] : []))];
    const owners = ownerIds.length ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : [];
    const entries: DispatchHistoryEntry[] = batches.map(batch => {
      const data = batch.value as unknown as StoredBatch;
      const id = batch.key.slice("private:dispatch-result:".length);
      const recorded = messages.filter(message => (message.rawPayload as { batchId?: string })?.batchId === id);
      const contacts = data.contacts ?? recorded.map(message => ({
        phone: message.conversation.phone, status: "accepted" as const, detail: "",
        attemptedAt: message.createdAt.toISOString(), providerMessageId: message.providerId ?? undefined,
      }));
      return {
        id, createdAt: data.startedAt ?? batch.createdAt.toISOString(), title: data.title ?? "Campanha anterior",
        mode: data.mode ?? (recorded[0]?.rawPayload as { mode?: string })?.mode ?? "template",
        message: data.message ?? recorded[0]?.body, sender: owners.find(owner => owner.id === data.userId)?.name ?? "Não registrado",
        total: data.total, accepted: data.accepted, failed: data.failed, uncertain: data.uncertain, isTest: data.isTest === true,
        contacts: contacts.map(contact => applyDeliveryEvents(contact, events, recorded.some(message => message.conversation.phone === contact.phone && message.conversation.messages.length > 0))),
        missingContacts: Math.max(0, data.total - contacts.length),
      };
    });
    return privateJsonResponse(request, successResponse("Histórico consultado.", { entries, total, offset, hasMore: offset + batches.length < total }));
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json(errorResponse("Não foi possível carregar o histórico. Tente novamente."), { status: 500 });
  }
}
