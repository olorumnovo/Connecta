import { privateJsonResponse } from "@/lib/private-json-response";
import { NextResponse } from "next/server";
import { authErrorResponse } from "@/lib/api-errors";
import { errorResponse, successResponse } from "@/lib/api-response";
import { requireCurrentUser } from "@/lib/auth-context";
import { ConversationService } from "@/modules/chatbot/services/conversation.service";

const conversationService = new ConversationService();

export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser();
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("conversationId");
    if (searchParams.get("summaryOnly") === "1") {
      return privateJsonResponse(request, successResponse("Contagens consultadas.", await conversationService.getSummary(user)));
    }
    const offset = Number(searchParams.get("offset") ?? "0");
    const limit = Number(searchParams.get("limit") ?? "25");
    const filter = searchParams.get("filter");
    const messagesOffset = Number(searchParams.get("messagesOffset") ?? "0");
    const messagesLimit = Number(searchParams.get("messagesLimit") ?? "40");

    if (conversationId) {
      const conversation = await conversationService.getDetail(conversationId, user, {
        offset: Number.isFinite(messagesOffset) && messagesOffset > 0 ? messagesOffset : 0,
        limit: Number.isFinite(messagesLimit) && messagesLimit > 0 ? Math.min(messagesLimit, 100) : 40,
      });
      return privateJsonResponse(request, successResponse("Conversa consultada.", conversation));
    }

    const [conversations, users] = await Promise.all([
      conversationService.list({
        offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 25,
        user,
        includeSummary: searchParams.get("includeSummary") !== "0",
        filter: filter === "unavailable" || filter === "finished" || filter === "stalled" ? filter : "all",
      }),
      conversationService.listAssignableUsers(),
    ]);

    return privateJsonResponse(request, successResponse("Conversas consultadas.", { conversations, users }));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json(errorResponse("Nao foi possivel consultar as conversas."), {
      status: 500,
    });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    const body = await request.json();
    const detail = await conversationService.sendManualMessage({
      conversationId: String(body.conversationId ?? ""),
      content: String(body.content ?? "").trim(),
      user,
    });

    return NextResponse.json(successResponse("Mensagem enviada.", detail));
  } catch (error) {
    const authError = authErrorResponse(error);
    if (authError) return authError;
    return NextResponse.json(errorResponse(error instanceof Error ? error.message : "Nao foi possivel enviar a mensagem."), {
      status: 500,
    });
  }
}
