import { NextResponse } from "next/server";
import { authErrorResponse } from "@/lib/api-errors";
import { errorResponse, successResponse } from "@/lib/api-response";
import { requireCurrentUser } from "@/lib/auth-context";
import { assertPermission } from "@/lib/permissions";
import { permissions } from "@/constants/permissions";
import { MassMessageService, MassMessageValidationError } from "@/modules/envio-em-massa/services/mass-message.service";
import { MetaApiError } from "@/services/meta/meta.service";
import { MAX_BATCH_CONTACTS } from "@/modules/envio-em-massa/schemas/mass-message.schema";
import { listDispatchAccounts } from "@/modules/contas/accounts";

const massMessageService = new MassMessageService();

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser();
    assertPermission(user, permissions.agentsEdit);

    const params = new URL(request.url).searchParams;
    const accounts = await listDispatchAccounts();
    if (params.get("accounts") === "1") {
      return NextResponse.json(successResponse("Contas de disparo carregadas.", { accounts, maxBatchContacts: MAX_BATCH_CONTACTS }), { headers: { "Cache-Control": "no-store" } });
    }
    const templates = await massMessageService.listTemplates(params.get("accountId") || undefined);

    return NextResponse.json(
      successResponse("Templates carregados.", {
        templates,
        accounts,
        maxBatchContacts: MAX_BATCH_CONTACTS,
      }),
    );
  } catch (error) {
    return handleError(error, "Não foi possível carregar os templates da Meta.");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireCurrentUser();
    assertPermission(user, permissions.agentsEdit);

    const input = await request.json().catch(() => {
      throw new MassMessageValidationError("Envie os dados do disparo em JSON válido.");
    });

    const result = await massMessageService.send(input, user);

    return NextResponse.json(successResponse("Disparo em massa processado pela Meta.", result));
  } catch (error) {
    return handleError(error, "Não foi possível concluir o envio em massa.");
  }
}

function handleError(error: unknown, fallbackMessage: string) {
  const authError = authErrorResponse(error);
  if (authError) return authError;

  const message = error instanceof Error ? error.message : fallbackMessage;
  const status =
    error instanceof MassMessageValidationError
      ? error.statusCode
      : error instanceof MetaApiError
        ? error.statusCode
        : 500;

  return NextResponse.json(errorResponse(message), { status });
}
