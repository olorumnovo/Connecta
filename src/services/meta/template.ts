export type MetaTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  parameter_format?: string;
  components: Array<{
    type: string;
    format?: string;
    text?: string;
    buttons?: Array<{ type: string; text?: string; url?: string }>;
  }>;
};

export function templateVariables(text = "") {
  const variables = [...new Set(Array.from(text.matchAll(/\{\{([^{}]+)\}\}/g), (match) => match[1].trim()))];
  return variables.every((value) => /^\d+$/.test(value))
    ? variables.sort((a, b) => Number(a) - Number(b))
    : variables;
}

export function unsupportedTemplateReason(template: MetaTemplate): string | null {
  if (template.status !== "APPROVED") return "Template não está aprovado.";
  if (template.category === "AUTHENTICATION") return "Templates de autenticação não estão disponíveis para campanhas.";
  if (!template.components.some((component) => component.type === "BODY")) return "Template sem corpo de texto.";
  const allVariables = template.components.flatMap((component) => templateVariables(component.text));
  const hasNamedVariables = allVariables.some((value) => !/^\d+$/.test(value));
  const hasNumericVariables = allVariables.some((value) => /^\d+$/.test(value));
  const namedFormat = template.parameter_format === "NAMED" || (hasNamedVariables && !hasNumericVariables);
  if (hasNamedVariables && hasNumericVariables) return "O template mistura formatos de variáveis que não podem ser enviados juntos.";
  if (template.parameter_format === "NAMED" && hasNumericVariables) return "As variáveis deste template não correspondem ao formato aprovado pela Meta.";
  if (namedFormat && allVariables.some((value) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(value))) {
    return "O template contém um nome de variável inválido. Confira o formato aprovado na Meta.";
  }
  for (const component of template.components) {
    if (!["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(component.type)) return "Este formato de template ainda não é suportado.";
    if (component.type === "HEADER" && !["TEXT", "IMAGE", "VIDEO", "DOCUMENT"].includes(component.format ?? "TEXT")) return "Este tipo de cabeçalho ainda não é suportado.";
    const variables = templateVariables(component.text);
    if (!namedFormat && variables.some((value, index) => value !== String(index + 1))) return "Use variáveis numéricas consecutivas: {{1}}, {{2}}.";
    if (component.type === "FOOTER" && variables.length) return "Rodapé com variáveis não suportado.";
    if (component.type === "BUTTONS" && component.buttons?.some((button) =>
      !["URL", "PHONE_NUMBER", "QUICK_REPLY"].includes(button.type) || templateVariables(button.url).length > 0,
    )) return "Nesta etapa, use botões estáticos, sem URL variável ou recursos avançados.";
  }
  return null;
}

export function buildTemplate(template: MetaTemplate, input: { headerValues: string[]; bodyValues: string[]; mediaUrl: string }) {
  const reason = unsupportedTemplateReason(template);
  if (reason) throw new Error(reason);
  const namedFormat = template.parameter_format === "NAMED" || template.components
    .flatMap((component) => templateVariables(component.text))
    .some((value) => !/^\d+$/.test(value));
  const components: Array<Record<string, unknown>> = [];
  const header = template.components.find((item) => item.type === "HEADER");
  const body = template.components.find((item) => item.type === "BODY");
  for (const [type, component, values] of [
    ["header", header, input.headerValues],
    ["body", body, input.bodyValues],
  ] as const) {
    const variables = templateVariables(component?.text);
    const expected = variables.length;
    if (values.length !== expected || values.some((value) => !value.trim())) throw new Error(`Preencha as ${expected} variáveis do ${type === "header" ? "cabeçalho" : "corpo"}.`);
    if (values.length) components.push({
      type,
      parameters: values.map((text, index) => ({
        type: "text",
        ...(namedFormat ? { parameter_name: variables[index] } : {}),
        text,
      })),
    });
  }
  if (header?.format && ["IMAGE", "VIDEO", "DOCUMENT"].includes(header.format)) {
    let url: URL;
    try { url = new URL(input.mediaUrl); } catch { throw new Error("Informe uma URL HTTPS pública para a mídia do template."); }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("A mídia deve usar uma URL HTTPS pública sem credenciais.");
    const type = header.format.toLowerCase();
    components.push({ type: "header", parameters: [{ type, [type]: { link: url.href } }] });
  } else if (input.mediaUrl) {
    throw new Error("O template selecionado não possui cabeçalho de mídia.");
  }
  return { name: template.name, language: { code: template.language }, ...(components.length ? { components } : {}) };
}
