import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { getMetaConfig, type MetaConfig } from "@/services/meta/meta.service";

export const ACCOUNT_PREFIX = "private:whatsapp-account:";
export const CHATBOT_AGENT_PREFIX = "private:chatbot-agent:";
export const accountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().regex(/^\+?[\d\s()-]+$/).transform(value => value.replace(/\D/g, "")).pipe(z.string().min(10).max(15)),
  phoneNumberId: z.string().trim().regex(/^\d+$/),
  wabaId: z.string().trim().regex(/^\d+$/),
  verifyToken: z.string().trim().max(512).default(""),
  apiVersion: z.string().trim().regex(/^v\d+\.0$/),
  accessToken: z.string().trim().max(4096).default(""),
  purpose: z.enum(["DISPATCH", "CHATBOT"]),
});
export type Account = z.infer<typeof accountSchema>;
type StoredAccount = Omit<Account, "accessToken" | "verifyToken"> & {
  id: string; createdAt: string; credentials: string;
};

function encryptionKey() {
  if (!process.env.JWT_SECRET) throw new Error("Missing encryption key");
  return createHash("sha256").update(process.env.JWT_SECRET).digest();
}
function seal(value: { accessToken: string; verifyToken: string }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64")).join(".");
}
function unseal(value: string): { accessToken: string; verifyToken: string } {
  const [iv, tag, data] = value.split(".").map(part => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
}
function publicAccount(account: StoredAccount) {
  const { credentials, ...data } = account;
  return { ...data, source: "database" as const, hasAccessToken: Boolean(credentials) };
}
export function environmentAccount() {
  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!phoneNumberId) return null;
  return {
    id: "environment", name: "WhatsApp de disparos", phone: process.env.META_WHATSAPP_PHONE_NUMBER?.trim() || "",
    phoneNumberId, wabaId: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() || "",
    apiVersion: process.env.META_GRAPH_API_VERSION?.trim() || "", purpose: "DISPATCH",
    source: "environment", hasAccessToken: Boolean(process.env.META_WHATSAPP_ACCESS_TOKEN?.trim()),
    createdAt: "",
  };
}
let environmentDetails: { id: string; expires: number; phone: string; name: string } | undefined;

async function environmentAccountWithDetails() {
  const account = environmentAccount();
  if (!account) return null;
  if (environmentDetails?.id === account.phoneNumberId && environmentDetails.expires > Date.now()) {
    return { ...account, phone: environmentDetails.phone, name: environmentDetails.name };
  }
  try {
    if (!/^v\d+\.0$/.test(account.apiVersion) || !/^\d+$/.test(account.phoneNumberId)) return account;
    const response = await fetch(
      `https://graph.facebook.com/${account.apiVersion}/${account.phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${process.env.META_WHATSAPP_ACCESS_TOKEN?.trim()}` }, cache: "no-store", signal: AbortSignal.timeout(5000) },
    );
    if (response.ok) {
      const details = await response.json();
      environmentDetails = {
        id: account.phoneNumberId, expires: Date.now() + 300000,
        phone: typeof details.display_phone_number === "string" ? details.display_phone_number : account.phone,
        name: typeof details.verified_name === "string" ? details.verified_name : account.name,
      };
      return { ...account, phone: environmentDetails.phone, name: environmentDetails.name };
    }
  } catch { /* Keep the configured account visible even when Meta is unavailable. */ }
  return account;
}

export async function listAccounts() {
  const records = await prisma.appSetting.findMany({ where: { key: { startsWith: ACCOUNT_PREFIX } }, orderBy: { createdAt: "asc" } });
  const accounts = records.map(record => publicAccount(record.value as unknown as StoredAccount));
  const environment = await environmentAccountWithDetails();
  if (environment) {
    const metadata = await prisma.appSetting.findUnique({ where: { key: "private:whatsapp-environment:" + environment.phoneNumberId } });
    const custom = metadata?.value as { name?: string } | undefined;
    if (custom?.name?.trim()) environment.name = custom.name.trim();
  }
  return [...(environment ? [environment] : []), ...accounts];
}

export async function listDispatchAccounts() {
  return (await listAccounts())
    .filter(account => account.purpose === "DISPATCH" && account.hasAccessToken)
    .map(({ id, name, phone, phoneNumberId, wabaId, apiVersion, source }) => ({ id, name, phone, phoneNumberId, wabaId, apiVersion, source }));
}

export async function getDispatchMetaConfig(accountId?: string): Promise<MetaConfig> {
  const accounts = await listAccounts();
  const account = accountId
    ? accounts.find(item => item.id === accountId || item.phoneNumberId === accountId)
    : accounts.find(item => item.source === "environment" && item.purpose === "DISPATCH") ?? accounts.find(item => item.purpose === "DISPATCH");
  if (!account || account.purpose !== "DISPATCH") throw new Error("Selecione uma conta de WhatsApp cadastrada para disparos.");

  if (account.source === "environment") {
    return getMetaConfig();
  }

  const record = await prisma.appSetting.findUnique({ where: { key: ACCOUNT_PREFIX + account.phoneNumberId }, select: { value: true } });
  if (!record) throw new Error("A conta selecionada não está mais cadastrada.");
  const stored = record.value as unknown as StoredAccount;
  const credentials = unseal(stored.credentials);
  const config = {
    accessToken: credentials.accessToken,
    phoneNumberId: stored.phoneNumberId,
    businessAccountId: stored.wabaId,
    apiVersion: stored.apiVersion,
  };
  if (!config.accessToken || !/^\d+$/.test(config.phoneNumberId) || !/^\d+$/.test(config.businessAccountId) || !/^v\d+\.0$/.test(config.apiVersion)) {
    throw new Error("As credenciais desta conta estão incompletas. Revise o cadastro em Configurações de disparos.");
  }
  return config;
}

export async function getMetaConfigForPhoneNumber(phoneNumberId?: string): Promise<MetaConfig | null> {
  if (!phoneNumberId || !/^\d+$/.test(phoneNumberId)) return null;
  const environment = environmentAccount();
  if (environment?.phoneNumberId === phoneNumberId) {
    return getMetaConfig();
  }
  const record = await prisma.appSetting.findUnique({ where: { key: ACCOUNT_PREFIX + phoneNumberId }, select: { value: true } });
  if (!record) return null;
  const account = record.value as unknown as StoredAccount;
  const credentials = unseal(account.credentials);
  if (!credentials.accessToken || !/^v\d+\.0$/.test(account.apiVersion)) return null;
  return { accessToken: credentials.accessToken, phoneNumberId: account.phoneNumberId, businessAccountId: account.wabaId, apiVersion: account.apiVersion };
}

export async function listWebhookVerifyTokens() {
  const tokens = new Set<string>();
  const environmentToken = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
  if (environmentToken) tokens.add(environmentToken);
  const records = await prisma.appSetting.findMany({ where: { key: { startsWith: ACCOUNT_PREFIX } }, select: { value: true } });
  for (const record of records) {
    try {
      const account = record.value as unknown as StoredAccount;
      const token = unseal(account.credentials).verifyToken?.trim();
      if (token) tokens.add(token);
    } catch { /* Ignore malformed or outdated account records. */ }
  }
  return [...tokens];
}

export function dispatchAccountIdFromMemory(memory: unknown) {
  if (memory && typeof memory === "object" && !Array.isArray(memory)) {
    const id = (memory as Record<string, unknown>).dispatchLastSenderId;
    if (typeof id === "string" && /^\d+$/.test(id)) return id;
  }
  return "environment";
}

export async function getChatbotMetaConfig(phoneNumberId?: string): Promise<MetaConfig | null> {
  if (!phoneNumberId || !/^\d+$/.test(phoneNumberId)) return null;
  const record = await prisma.appSetting.findUnique({ where: { key: ACCOUNT_PREFIX + phoneNumberId }, select: { value: true } });
  if (!record) return null;
  const account = record.value as unknown as StoredAccount;
  if (account.purpose !== "CHATBOT") return null;
  const credentials = unseal(account.credentials);
  if (!credentials.accessToken || !/^v\d+\.0$/.test(account.apiVersion)) return null;
  return {
    accessToken: credentials.accessToken,
    phoneNumberId: account.phoneNumberId,
    businessAccountId: account.wabaId,
    apiVersion: account.apiVersion,
  };
}
export async function saveAccount(input: Account, editingId?: string) {
  const id = editingId || input.phoneNumberId;
  if (!/^\d+$/.test(id)) throw new Error("INVALID_ACCOUNT");
  const key = ACCOUNT_PREFIX + id;
  const record = await prisma.appSetting.findUnique({ where: { key } });
  const existing = record?.value as unknown as StoredAccount | undefined;
  if (editingId && !existing) throw new Error("INVALID_ACCOUNT");
  if (editingId && input.phoneNumberId !== existing?.phoneNumberId) throw new Error("IMMUTABLE_NUMBER");
  if (!editingId && (existing || input.phoneNumberId === environmentAccount()?.phoneNumberId)) throw new Error("DUPLICATE_ACCOUNT");
  const secrets = existing ? unseal(existing.credentials) : { accessToken: "", verifyToken: "" };
  const accessToken = input.accessToken || secrets.accessToken;
  const verifyToken = input.verifyToken || secrets.verifyToken;
  if (!accessToken || !verifyToken) throw new Error("MISSING_TOKENS");
  const { accessToken: _access, verifyToken: _verify, ...fields } = input;
  const account: StoredAccount = { ...fields, id, createdAt: existing?.createdAt || new Date().toISOString(), credentials: seal({ accessToken, verifyToken }) };
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: account }, update: { value: account } });
  if (account.purpose === "CHATBOT") {
    const agent = await prisma.agent.findFirst({
      where: { deletedAt: null, name: { equals: account.name, mode: "insensitive" } },
      select: { id: true },
    });
    if (agent) {
      await prisma.appSetting.upsert({
        where: { key: CHATBOT_AGENT_PREFIX + account.phoneNumberId },
        create: { key: CHATBOT_AGENT_PREFIX + account.phoneNumberId, value: { agentId: agent.id } },
        update: { value: { agentId: agent.id } },
      });
    }
  }
  return publicAccount(account);
}
