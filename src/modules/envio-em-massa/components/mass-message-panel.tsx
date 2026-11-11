"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, Megaphone, Send, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/utils/cn";
import { useCurrentUser } from "@/hooks/use-current-user";
import { addCampaignHistory } from "@/modules/envio-em-massa/history";

type DispatchResult = {
  total: number;
  accepted: number;
  failed: number;
  uncertain: number;
  contacts: Array<{
    phone: string;
    status: "accepted" | "failed" | "uncertain";
    detail: string;
    providerMessageId?: string;
  }>;
};

type DispatchAccount = { id: string; name: string; phone: string; phoneNumberId: string };

const LAST_MASS_MESSAGE_RESULT_KEY = "connecta:meta:last-mass-message-result";

export function MassMessagePanel() {
  const { data: user } = useCurrentUser();
  const [testPhone, setTestPhone] = useState("");
  const [testConsent, setTestConsent] = useState(false);
  const [testResult, setTestResult] = useState<DispatchResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [contacts, setContacts] = useState("");
  const [accounts, setAccounts] = useState<DispatchAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState("");
  const [mode, setMode] = useState<"text" | "template">("text");
  const [message, setMessage] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [language, setLanguage] = useState("pt_BR");
  const [mediaType, setMediaType] = useState<"" | "image" | "video" | "document">("");
  const [headerValues, setHeaderValues] = useState<string[]>([]);
  const [bodyValues, setBodyValues] = useState<string[]>([]);
  const [mediaUrl, setMediaUrl] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const maxBatchContacts = 100;
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DispatchResult | null>(null);
  const sendingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function loadAccounts() {
      try {
        const response = await fetch("/api/envio-em-massa?accounts=1", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || payload.status !== "success") throw new Error(payload.message || "Não foi possível carregar as contas de envio.");
        const available = (payload.data?.accounts ?? []) as DispatchAccount[];
        if (!cancelled) {
          setAccounts(available);
          setAccountId(current => current && available.some(account => account.id === current) ? current : available[0]?.id ?? "");
          if (!available.length) setAccountsError("Cadastre uma conta de disparo em Configurações de disparos.");
        }
      } catch (loadError) {
        if (!cancelled) setAccountsError(loadError instanceof Error ? loadError.message : "Não foi possível carregar as contas de envio.");
      } finally { if (!cancelled) setAccountsLoading(false); }
    }
    void loadAccounts();
    return () => { cancelled = true; };
  }, []);

  const estimatedContacts = useMemo(() => {
    const unique = new Set(
      contacts
        .split(/\r?\n|;|,/)
        .map((item) => item.replace(/\D/g, ""))
        .filter((item) => item.length >= 10),
    );

    return unique.size;
  }, [contacts]);

  const preview = mode === "text" ? message : templateName ? `Template: ${templateName} (${language})` : "";

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LAST_MASS_MESSAGE_RESULT_KEY);
      if (!stored) return;

      const parsed = JSON.parse(stored) as DispatchResult;
      if (
        typeof parsed?.total === "number" &&
        typeof parsed?.accepted === "number" &&
        typeof parsed?.failed === "number" &&
        typeof parsed?.uncertain === "number" &&
        Array.isArray(parsed?.contacts)
      ) {
        setResult(parsed);
      }
    } catch {
      window.localStorage.removeItem(LAST_MASS_MESSAGE_RESULT_KEY);
    }
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>, test = false) {
    event.preventDefault();
    if (sendingRef.current) return;
    sendingRef.current = true;
    setIsSending(true);
    setSendingTest(test);
    if (test) { setTestError(null); setTestResult(null); } else setError(null);

    try {
      const response = await fetch("/api/envio-em-massa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactsText: test ? testPhone : contacts,
          accountId,
          isTest: test,
          mode, message, templateName, language, mediaType,
          headerValues,
          bodyValues,
          mediaUrl,
          consentConfirmed: test ? testConsent : consentConfirmed,
        }),
      });
      const payload = (await response.json()) as {
        status: "success" | "error";
        message: string;
        data?: DispatchResult;
      };

      if (!response.ok || payload.status !== "success" || !payload.data) {
        throw new Error(payload.message || "Não foi possível concluir o envio.");
      }

      if (test) setTestResult(payload.data);
      else {
        setResult(payload.data);
        try {
          if (!user?.id) throw new Error("Usuário indisponível");
          addCampaignHistory(user.id, {
            id: crypto.randomUUID(), createdAt: new Date().toISOString(),
            title: mode === "template" ? templateName : "Campanha de texto livre",
            mode, result: payload.data,
          });
          window.localStorage.setItem(LAST_MASS_MESSAGE_RESULT_KEY, JSON.stringify(payload.data));
        } catch {
          setError("O envio foi processado, mas não foi possível salvar o histórico neste navegador. Confira o resultado abaixo antes de reenviar.");
        }
      }
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Falha no envio em massa.";
      if (test) setTestError(message); else setError(message);
    } finally {
      sendingRef.current = false;
      setIsSending(false);
      setSendingTest(false);
    }
  }

  const messageReady = mode === "text" ? Boolean(message.trim()) : Boolean(templateName.trim() && language.trim());
  const submitDisabled = isSending || accountsLoading || !accountId || !messageReady || !contacts.trim() || !consentConfirmed;

  return (
    <div className="dispatch-layout">
      <Card className="dispatch-editor overview-card overview-red relative isolate min-w-0 overflow-hidden rounded-2xl border-border/70 bg-card">
        <CardHeader className="mb-0 border-0 bg-none p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-primary/10 p-3 text-primary">
              <Megaphone className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Novo disparo</CardTitle>
              <CardDescription>
                Prepare sua mensagem e selecione quem vai recebê-la.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="dispatch-editor-body p-5 pt-0 sm:p-6 sm:pt-0">
          <form className="space-y-5" onSubmit={(event) => void handleSubmit(event)}>
            <fieldset className="space-y-5" disabled={isSending}>
              <label className="grid gap-2"><span className="text-xs font-semibold">Conta de envio</span><select value={accountId} onChange={event => setAccountId(event.target.value)} disabled={accountsLoading || !accounts.length} className="h-11 w-full rounded-xl border bg-background px-3 text-sm"><option value="">{accountsLoading ? "Carregando contas…" : "Selecione uma conta"}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.phone || account.phoneNumberId}</option>)}</select><span className="text-[11px] text-muted-foreground">O disparo e os templates usarão esta conta do WhatsApp.</span>{accountsError && <span role="alert" className="text-xs text-destructive">{accountsError}</span>}</label>
              <div className="space-y-2"><p className="text-xs font-semibold">Tipo de envio</p><div role="group" aria-label="Tipo de envio" className="inline-flex gap-1 rounded-xl bg-muted/60 p-1">{([{ value: "text", label: "Texto livre" }, { value: "template", label: "Template Meta" }] as const).map((item) => <button key={item.value} type="button" aria-pressed={mode === item.value} onClick={() => setMode(item.value)} className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${mode === item.value ? "bg-primary text-white shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{item.label}</button>)}</div></div>
              {mode === "text" ? <label className="grid gap-2"><span className="text-sm font-semibold">Mensagem</span><Textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4096} placeholder="Digite a mensagem que será enviada…" className="min-h-44 rounded-xl bg-muted/20" /><span className="text-[11px] text-muted-foreground">Texto livre depende de uma janela de atendimento aberta na Meta.</span></label> : <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2"><span className="text-xs font-semibold">Nome do template</span><Input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="ex: promocao_maio" className="h-11 rounded-xl bg-muted/20" /></label><label className="grid gap-2"><span className="text-xs font-semibold">Idioma</span><Input value={language} onChange={(event) => setLanguage(event.target.value)} placeholder="pt_BR" className="h-11 rounded-xl bg-muted/20" /></label></div>
                <p className="text-[11px] text-muted-foreground">Digite o nome e o idioma exatamente como aprovados na Meta.</p>
                <div className="space-y-2"><p className="text-xs font-semibold">Mídia do cabeçalho</p><div className="flex flex-wrap gap-2">{([{ value: "", label: "Sem mídia" }, { value: "image", label: "Imagem" }, { value: "video", label: "Vídeo" }, { value: "document", label: "Documento" }] as const).map((item) => <button key={item.value} type="button" aria-pressed={mediaType === item.value} onClick={() => { setMediaType(item.value); setMediaUrl(""); }} className={`rounded-lg border px-3 py-2 text-xs ${mediaType === item.value ? "border-primary bg-primary/5 text-primary" : "text-muted-foreground"}`}>{item.label}</button>)}</div></div>
                {mediaType && <label className="grid gap-2"><span className="text-xs font-semibold">URL da mídia</span><Input type="url" value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} placeholder="https://seudominio.com/arquivo" className="h-11 rounded-xl" /><span className="text-[11px] text-muted-foreground">Use uma URL HTTPS pública compatível com o template.</span></label>}
                <details className="rounded-xl border p-3"><summary className="cursor-pointer text-xs font-medium">Variáveis do template (opcional)</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-xs">Cabeçalho<Textarea value={headerValues.join("\n")} onChange={(event) => setHeaderValues(event.target.value ? event.target.value.split("\n") : [])} placeholder="Um valor por linha, na ordem das variáveis" /></label><label className="grid gap-2 text-xs">Corpo da mensagem<Textarea value={bodyValues.join("\n")} onChange={(event) => setBodyValues(event.target.value ? event.target.value.split("\n") : [])} placeholder="Um valor por linha, na ordem das variáveis" /></label></div></details>
              </div>}

              <div className="grid gap-2">
                <label htmlFor="dispatch-contacts" className="text-sm font-semibold">Destinatários</label>
                <Textarea
                  id="dispatch-contacts"
                  value={contacts}
                  onChange={(event) => setContacts(event.target.value)}
                  placeholder={"Cole um número por linha\n5511999999999\n5511988887777"}
                  className="min-h-40 rounded-xl bg-muted/20"
                />
                <p className="text-xs text-muted-foreground">
                  Separe por linha, vírgula ou ponto e vírgula. Detectados: <strong>{estimatedContacts}</strong> de {maxBatchContacts}.
                </p>
              </div>


              <label className="flex items-start gap-3 text-xs leading-5">
                <input
                  type="checkbox"
                  checked={consentConfirmed}
                  onChange={(event) => setConsentConfirmed(event.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <span className="text-muted-foreground">
                  Confirmo que os contatos desta lista autorizaram receber mensagens desta empresa pelo WhatsApp.
                </span>
              </label>
            </fieldset>

            {error ? (
              <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {error}
              </div>
            ) : null}

            <Button type="submit" className="h-11 rounded-xl px-5" disabled={submitDisabled}>
              {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {isSending && !sendingTest ? "Enviando campanha..." : "Enviar campanha"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="dispatch-aside space-y-4">
        <Card className="overview-card overview-red relative isolate min-w-0 overflow-hidden rounded-2xl border-border/70 bg-card">
          <CardHeader className="mb-0 border-0 bg-none p-5"><CardTitle>Teste individual</CardTitle><CardDescription>Confira a mensagem em um único número antes da campanha.</CardDescription></CardHeader>
          <CardContent className="p-5 pt-0">
            <form className="space-y-4" onSubmit={(event) => void handleSubmit(event, true)}>
              <label className="block space-y-2"><span className="text-xs font-medium">Telefone de teste</span><Input value={testPhone} onChange={(event) => setTestPhone(event.target.value)} type="tel" inputMode="tel" pattern="[+]?[0-9]{10,15}" required placeholder="5511999999999" className="h-11 rounded-xl bg-muted/20" disabled={isSending} /><span className="block text-[11px] text-muted-foreground">Inclua o código do país e o DDD.</span></label>
              <label className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><input type="checkbox" checked={testConsent} onChange={(event) => setTestConsent(event.target.checked)} disabled={isSending} className="mt-1 accent-red-600" />Tenho autorização para enviar a este número.</label>
              <Button type="submit" className="h-11 w-full rounded-xl" disabled={isSending || accountsLoading || !accountId || !messageReady || !testConsent || !testPhone.trim()}>{sendingTest ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Send className="h-4 w-4" />}{sendingTest ? "Enviando teste…" : "Enviar teste"}</Button>
              {testError && <p role="alert" className="text-xs text-destructive">{testError}</p>}
              {testResult && <div role="status" className="rounded-xl border p-3 text-xs"><p className="mb-2 font-semibold">Resultado do teste</p>{testResult.contacts.map((contact) => <div key={contact.phone} className="space-y-2"><StatusPill status={contact.status} /><p className="text-muted-foreground">{contact.detail}</p></div>)}</div>}
            </form>
          </CardContent>
        </Card>
        <Card className="min-w-0 overflow-hidden rounded-2xl border-border/70 bg-card">
          <CardHeader className="mb-0 border-0 bg-none p-5"><CardTitle>Prévia da mensagem</CardTitle><CardDescription>{mode === "text" ? "Texto que será enviado aos contatos." : "Identificação do template informado."}</CardDescription></CardHeader>
          <CardContent className="p-5 pt-0"><div className="rounded-xl bg-muted/40 p-4"><div className="rounded-2xl rounded-tl-sm border border-border/50 bg-card p-4 text-sm leading-6 shadow-sm"><p className="whitespace-pre-wrap break-words">{preview || "Sua mensagem aparecerá aqui."}</p></div></div><p className="mt-3 text-[11px] leading-5 text-muted-foreground">{mode === "text" ? "O mesmo texto será enviado aos destinatários." : "O conteúdo final é o aprovado na Meta. As variáveis serão usadas em todo o lote."}</p></CardContent>
        </Card>

        <Card className="overview-card overview-red relative isolate min-w-0 overflow-hidden rounded-2xl border-border/70 bg-card">
          <CardHeader className="mb-0 border-0 bg-none p-5 sm:p-6">
            <CardTitle>Resultado do último envio</CardTitle>
            <CardDescription>Resumo rápido do lote processado.</CardDescription>
          </CardHeader>
          <CardContent className="p-5 pt-0 sm:p-6 sm:pt-0">
            {result ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  <ResultMetric label="Total" value={String(result.total)} tone="slate" />
                  <ResultMetric label="Aceitas" value={String(result.accepted)} tone="emerald" />
                  <ResultMetric label="Incerto" value={String(result.uncertain)} tone="amber" />
                  <ResultMetric label="Falhas" value={String(result.failed)} tone="rose" />
                </div>

                <div className="max-h-80 space-y-2 overflow-y-auto">
                  {result.contacts.map((contact) => (
                    <div key={`${contact.phone}-${contact.providerMessageId ?? contact.status}`} className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm">
                      <div>
                        <p className="font-medium">{contact.phone}</p>
                        <p className="text-xs text-muted-foreground">{contact.detail}</p>
                        {contact.providerMessageId ? <p className="text-xs text-muted-foreground">ID Meta: {contact.providerMessageId}</p> : null}
                      </div>
                      <StatusPill status={contact.status} />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                Faça um disparo para ver o resumo de aceite, falha e status incerto.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: DispatchResult["contacts"][number]["status"] }) {
  const config = {
    accepted: { label: "Aceita", className: "bg-emerald-500/10 text-emerald-700", icon: CheckCircle2 },
    uncertain: { label: "Incerto", className: "bg-amber-500/10 text-amber-700", icon: TriangleAlert },
    failed: { label: "Falhou", className: "bg-rose-500/10 text-rose-700", icon: TriangleAlert },
  }[status];
  const Icon = config.icon;

  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold", config.className)}>
      <Icon className="h-3.5 w-3.5" />
      {config.label}
    </span>
  );
}

function ResultMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "slate" | "emerald" | "amber" | "rose";
}) {
  const toneClass =
    tone === "emerald"
      ? "bg-emerald-500/10 text-emerald-700"
      : tone === "amber"
        ? "bg-amber-500/10 text-amber-700"
        : tone === "rose"
          ? "bg-rose-500/10 text-rose-700"
          : "bg-slate-500/10 text-slate-700";

  return (
    <div className={cn("rounded-md border px-3 py-3", toneClass)}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em]">{label}</p>
      <p className="mt-2 text-xl font-semibold">{value}</p>
    </div>
  );
}
