/**
 * Envio transacional pelo Resend ou Brevo. O provedor é escolhido pelas
 * credenciais disponíveis; EMAIL_PROVIDER=resend|brevo pode fixar a escolha.
 * O remetente precisa estar verificado no painel do provedor selecionado.
 */

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  tags?: string[];
  idempotencyKey?: string;
};

type EmailProvider = "brevo" | "resend";

type EmailConfiguration = {
  provider: EmailProvider;
  providerName: "Brevo" | "Resend";
  apiKey: string;
  fromEmail: string;
  fromName: string;
  from: string;
};

export type SettlementEmailPurchase = {
  title: string;
  boughtAt: string | null;
  amount: number;
};

export type SettlementEmailAccount = {
  creditorName: string;
  pixKey: string | null;
  amount: number;
  grossOwed: number;
  grossCredit: number;
  pendingPaymentAmount: number;
  charges: SettlementEmailPurchase[];
  credits: SettlementEmailPurchase[];
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

function formatEmailDate(value: string | null) {
  if (!value) return "Data não informada";
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00`
    : value;
  const date = new Date(normalized);
  // O envio roda no servidor (UTC); sem o fuso da casa, pagamentos feitos
  // depois das 21h apareceriam com a data do dia seguinte.
  return Number.isNaN(date.getTime())
    ? "Data não informada"
    : date.toLocaleDateString("pt-BR", {
        timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? undefined : "America/Sao_Paulo",
      });
}

function parseSender(value?: string) {
  const configured = value?.trim();
  if (!configured) return null;
  const bracketMatch = configured.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  const email = (bracketMatch?.[2] ?? configured).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const name = bracketMatch?.[1]
    ?.trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  return { email, name: name || null };
}

function providerPreference(): EmailProvider | null | "invalid" {
  const value = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (!value) return null;
  return value === "brevo" || value === "resend" ? value : "invalid";
}

function configurationFor(provider: EmailProvider): EmailConfiguration | null {
  const apiKey = (
    provider === "brevo"
      ? process.env.BREVO_API_KEY
      : process.env.RESEND_API_KEY
  )?.trim();
  if (!apiKey) return null;

  const sender = parseSender(
    provider === "brevo"
      ? process.env.BREVO_FROM_EMAIL ?? process.env.EMAIL_FROM ?? process.env.RESEND_FROM
      : process.env.RESEND_FROM ?? process.env.EMAIL_FROM ?? process.env.BREVO_FROM_EMAIL,
  );
  if (!sender) return null;

  const fromName =
    sender.name || process.env.BREVO_FROM_NAME?.trim() || "Casa Cinco";
  return {
    provider,
    providerName: provider === "brevo" ? "Brevo" : "Resend",
    apiKey,
    fromEmail: sender.email,
    fromName,
    from: `${fromName} <${sender.email}>`,
  };
}

function emailConfiguration() {
  const preferred = providerPreference();
  if (preferred === "invalid") return null;
  if (preferred) return configurationFor(preferred);
  return configurationFor("brevo") ?? configurationFor("resend");
}

export function emailConfigurationError() {
  const preferred = providerPreference();
  if (preferred === "invalid") {
    return "EMAIL_PROVIDER deve ser 'resend' ou 'brevo'.";
  }
  if (preferred === "resend") {
    return "Configure RESEND_API_KEY e RESEND_FROM com um remetente verificado.";
  }
  if (preferred === "brevo") {
    return "Configure BREVO_API_KEY e BREVO_FROM_EMAIL com um remetente verificado.";
  }
  return "Configure RESEND_API_KEY e RESEND_FROM, ou BREVO_API_KEY e BREVO_FROM_EMAIL, com um remetente verificado.";
}

export function emailProviderName() {
  return emailConfiguration()?.providerName ?? null;
}

export function emailConfigured() {
  return Boolean(emailConfiguration());
}

function responseDetail(body: string) {
  if (!body) return "resposta sem detalhes";
  try {
    const parsed = JSON.parse(body) as {
      message?: string;
      error?: string | { message?: string };
    };
    if (typeof parsed.message === "string") return parsed.message.slice(0, 500);
    if (typeof parsed.error === "string") return parsed.error.slice(0, 500);
    if (parsed.error?.message) return parsed.error.message.slice(0, 500);
  } catch {
    // O corpo nem sempre é JSON (por exemplo, em falhas de proxy/CDN).
  }
  return body.slice(0, 500);
}

function resendTags(tags?: string[]) {
  return tags?.map((tag, index) => ({
    name: index === 0 ? "category" : `category_${index + 1}`,
    value: tag.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 256),
  }));
}

export async function sendEmail({
  to,
  subject,
  html,
  tags,
  idempotencyKey,
}: SendEmailInput) {
  const configuration = emailConfiguration();
  if (!configuration) throw new Error(emailConfigurationError());
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
    throw new Error("O endereço de e-mail do destinatário é inválido.");
  }

  const normalizedIdempotencyKey = idempotencyKey?.trim().slice(0, 256);
  const response =
    configuration.provider === "brevo"
      ? await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: {
            "api-key": configuration.apiKey,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sender: {
              name: configuration.fromName,
              email: configuration.fromEmail,
            },
            to: [{ email: to.trim() }],
            subject,
            htmlContent: html,
            tags,
          }),
        })
      : await fetch("https://api.resend.com/emails", {
          method: "POST",
          signal: AbortSignal.timeout(15_000),
          headers: {
            Authorization: `Bearer ${configuration.apiKey}`,
            "Content-Type": "application/json",
            ...(normalizedIdempotencyKey
              ? { "Idempotency-Key": normalizedIdempotencyKey }
              : {}),
          },
          body: JSON.stringify({
            from: configuration.from,
            to: [to.trim()],
            subject,
            html,
            tags: resendTags(tags),
          }),
        });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `${configuration.providerName} ${response.status}: ${responseDetail(body)}`,
    );
  }

  let result: { messageId?: string; id?: string };
  try {
    result = JSON.parse(body) as { messageId?: string; id?: string };
  } catch {
    throw new Error(
      `${configuration.providerName} aceitou a chamada, mas devolveu uma resposta inválida.`,
    );
  }
  const messageId = result.messageId ?? result.id;
  if (!messageId) {
    throw new Error(
      `${configuration.providerName} aceitou a chamada, mas não devolveu o identificador do envio.`,
    );
  }

  return { messageId, provider: configuration.providerName };
}

export function expenseReminderEmail(params: {
  memberName: string;
  expenseTitle: string;
  amount: number;
  dueDate: string;
  daysLeft: number;
  appUrl: string;
}) {
  const { memberName, expenseTitle, amount, dueDate, daysLeft, appUrl } = params;
  const formattedAmount = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(amount);
  const formattedDate = new Date(`${dueDate}T00:00:00`).toLocaleDateString("pt-BR");
  const urgency =
    daysLeft < 0
      ? `está atrasada há ${Math.abs(daysLeft)} dia(s)`
      : daysLeft === 0
        ? "vence hoje"
        : `vence em ${daysLeft} dia(s)`;

  const subject =
    daysLeft < 0
      ? `Despesa atrasada: ${expenseTitle}`
      : `Lembrete: ${expenseTitle} vence em ${daysLeft} dia(s)`;

  const html = `
    <div style="font-family: Inter, Arial, sans-serif; background:#0e1320; padding:32px; color:#f5f7ff;">
      <div style="max-width:480px; margin:0 auto; background:#141a29; border-radius:16px; padding:28px; border:1px solid rgba(255,255,255,0.08);">
        <p style="color:#9099ad; text-transform:uppercase; font-size:11px; letter-spacing:.08em; margin:0 0 8px;">Casa Cinco</p>
        <h1 style="font-size:20px; margin:0 0 16px;">Olá, ${memberName.split(" ")[0]}!</h1>
        <p style="font-size:14px; line-height:1.6; color:#d7dcea;">
          Sua parte na despesa <strong>${expenseTitle}</strong> ${urgency}.
        </p>
        <div style="background:#1a2132; border-radius:12px; padding:16px; margin:20px 0;">
          <p style="margin:0; font-size:13px; color:#9099ad;">Valor devido</p>
          <p style="margin:4px 0 0; font-size:24px; font-weight:700;">${formattedAmount}</p>
          <p style="margin:8px 0 0; font-size:13px; color:#9099ad;">Vencimento: ${formattedDate}</p>
        </div>
        <a href="${appUrl}/app/eu" style="display:inline-block; background:#8b5cf6; color:#fff; text-decoration:none; padding:12px 20px; border-radius:10px; font-size:14px; font-weight:600;">
          Ver e pagar no app
        </a>
        <p style="font-size:12px; color:#666f85; margin-top:24px;">
          Você pode consultar a chave PIX dos moradores na página de Moradores.
        </p>
      </div>
    </div>
  `;

  return { subject, html };
}

export function dailyChoreReminderEmail(params: {
  memberName: string;
  reminderDate: string;
  tasks: { label: string; description: string | null }[];
  appUrl: string;
}) {
  const { memberName, reminderDate, tasks, appUrl } = params;
  const firstName = escapeHtml(memberName.trim().split(/\s+/)[0] || memberName);
  const formattedDate = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(new Date(`${reminderDate}T00:00:00.000Z`));
  const taskItems = tasks
    .map(
      (task) => `
        <li style="background:#1a2132;border:1px solid rgba(255,255,255,.08);border-radius:12px;margin:0 0 9px;padding:14px 15px;">
          <strong style="color:#f5f7ff;display:block;font-size:14px;line-height:1.45;">${escapeHtml(task.label)}</strong>
          ${
            task.description
              ? `<span style="color:#aeb6c8;display:block;font-size:12px;line-height:1.5;margin-top:4px;">${escapeHtml(task.description)}</span>`
              : ""
          }
        </li>`,
    )
    .join("");

  const subject = `Hoje é seu dia de cuidar da casa, ${firstName}`;
  const html = `
    <!doctype html>
    <html lang="pt-BR">
      <body style="background:#0e1320;margin:0;padding:0;">
        <div style="background:#0e1320;padding:32px 14px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
          <div style="max-width:520px;margin:0 auto;background:#141a29;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:26px;">
            <p style="color:#a78bfa;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin:0 0 9px;">Casa Cinco • Rotina diária</p>
            <h1 style="color:#ffffff;font-size:23px;letter-spacing:-.02em;margin:0 0 8px;">Bom dia, ${firstName}!</h1>
            <p style="color:#b7bfce;font-size:14px;line-height:1.6;margin:0 0 20px;">
              Hoje, ${escapeHtml(formattedDate)}, é o seu dia na escala da casa. Estas são as tarefas combinadas:
            </p>
            <ul style="list-style:none;margin:0;padding:0;">${taskItems}</ul>
            <a href="${escapeHtml(appUrl.replace(/\/$/, ""))}/app/limpeza" style="display:inline-block;background:#7c3aed;border-radius:11px;color:#ffffff;font-size:14px;font-weight:700;margin-top:12px;padding:13px 21px;text-decoration:none;">Abrir a rotina de hoje</a>
            <p style="color:#747e91;font-size:11px;line-height:1.5;margin:20px 0 0;">
              Este lembrete é enviado uma única vez no início do seu dia de responsabilidade.
            </p>
          </div>
        </div>
      </body>
    </html>`;

  return { subject, html };
}

export function laundryReminderEmail(params: {
  memberName: string;
  reminderDate: string;
  duties: { label: string; description: string | null }[];
  appUrl: string;
}) {
  const { memberName, reminderDate, duties, appUrl } = params;
  const firstName = escapeHtml(memberName.trim().split(/\s+/)[0] || memberName);
  const formattedDate = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(new Date(`${reminderDate}T00:00:00.000Z`));
  const dutyItems = duties
    .map(
      (duty) => `
        <li style="background:#1a2132;border:1px solid rgba(255,255,255,.08);border-radius:12px;margin:0 0 9px;padding:14px 15px;">
          <strong style="color:#f5f7ff;display:block;font-size:14px;line-height:1.45;">${escapeHtml(duty.label)}</strong>
          ${
            duty.description
              ? `<span style="color:#aeb6c8;display:block;font-size:12px;line-height:1.5;margin-top:4px;">${escapeHtml(duty.description)}</span>`
              : ""
          }
        </li>`,
    )
    .join("");

  const subject = `Hoje é seu dia de lavar roupa, ${firstName}`;
  const html = `
    <!doctype html>
    <html lang="pt-BR">
      <body style="background:#0e1320;margin:0;padding:0;">
        <div style="background:#0e1320;padding:32px 14px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
          <div style="max-width:520px;margin:0 auto;background:#141a29;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:26px;">
            <p style="color:#22d3ee;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin:0 0 9px;">Casa Cinco • Lavanderia</p>
            <h1 style="color:#ffffff;font-size:23px;letter-spacing:-.02em;margin:0 0 8px;">Bom dia, ${firstName}!</h1>
            <p style="color:#b7bfce;font-size:14px;line-height:1.6;margin:0 0 20px;">
              Hoje, ${escapeHtml(formattedDate)}, você tem responsabilidade na lavanderia:
            </p>
            <ul style="list-style:none;margin:0;padding:0;">${dutyItems}</ul>
            <a href="${escapeHtml(appUrl.replace(/\/$/, ""))}/app/limpeza/lavanderia" style="display:inline-block;background:#0891b2;border-radius:11px;color:#ffffff;font-size:14px;font-weight:700;margin-top:12px;padding:13px 21px;text-decoration:none;">Abrir o calendário da lavanderia</a>
            <p style="color:#747e91;font-size:11px;line-height:1.5;margin:20px 0 0;">
              Este lembrete é enviado uma única vez no início do dia programado.
            </p>
          </div>
        </div>
      </body>
    </html>`;

  return { subject, html };
}

export function openSettlementsEmail(params: {
  debtorName: string;
  accounts: SettlementEmailAccount[];
  appUrl: string;
}) {
  const { debtorName, accounts, appUrl } = params;
  const total = accounts.reduce((sum, account) => sum + account.amount, 0);
  const firstName = escapeHtml(debtorName.trim().split(/\s+/)[0] || debtorName);

  const purchaseRows = (purchases: SettlementEmailPurchase[]) =>
    purchases
      .map(
        (purchase) => `
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #e7eaf0;color:#4b5565;font-size:13px;line-height:1.4;">
              ${escapeHtml(purchase.title)}
              <span style="display:block;color:#8a93a3;font-size:11px;margin-top:2px;">${formatEmailDate(purchase.boughtAt)}</span>
            </td>
            <td style="padding:8px 0 8px 12px;border-bottom:1px solid #e7eaf0;color:#202638;font-size:13px;font-weight:700;text-align:right;white-space:nowrap;">
              ${money.format(purchase.amount)}
            </td>
          </tr>`,
      )
      .join("");

  const accountCards = accounts
    .map((account) => {
      const creditorName = escapeHtml(account.creditorName);
      const pix = account.pixKey
        ? escapeHtml(account.pixKey)
        : "Chave PIX ainda não cadastrada";
      return `
        <div style="background:#ffffff;border:1px solid #e4e7ee;border-radius:16px;padding:20px;margin:16px 0;">
          <p style="color:#757f92;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0 0 6px;">Você paga para</p>
          <h2 style="color:#171b28;font-size:19px;margin:0;">${creditorName}</h2>
          <p style="color:#6d28d9;font-size:28px;font-weight:800;letter-spacing:-.03em;margin:8px 0 18px;">${money.format(account.amount)}</p>

          <div style="background:#f3efff;border:1px solid #ddd2ff;border-radius:12px;padding:14px 16px;margin-bottom:18px;">
            <p style="color:#6d28d9;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:0 0 5px;">Chave PIX de ${creditorName}</p>
            <p style="color:#27203d;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;font-weight:700;line-height:1.5;overflow-wrap:anywhere;margin:0;">${pix}</p>
          </div>

          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:14px;">
            <tr>
              <td style="color:#626b7c;font-size:13px;padding:5px 0;">Suas partes em compras pagas por ${creditorName}</td>
              <td style="color:#202638;font-size:13px;font-weight:700;text-align:right;padding:5px 0;white-space:nowrap;">${money.format(account.grossOwed)}</td>
            </tr>
            <tr>
              <td style="color:#626b7c;font-size:13px;padding:5px 0;">Compras pagas por você que foram compensadas</td>
              <td style="color:#16805b;font-size:13px;font-weight:700;text-align:right;padding:5px 0;white-space:nowrap;">− ${money.format(account.grossCredit)}</td>
            </tr>
            ${
              account.pendingPaymentAmount > 0
                ? `<tr>
                    <td style="color:#626b7c;font-size:13px;padding:5px 0;">Pagamento aguardando confirmação</td>
                    <td style="color:#16805b;font-size:13px;font-weight:700;text-align:right;padding:5px 0;white-space:nowrap;">− ${money.format(account.pendingPaymentAmount)}</td>
                  </tr>`
                : ""
            }
            <tr>
              <td style="border-top:1px solid #dfe3eb;color:#202638;font-size:14px;font-weight:700;padding:10px 0 0;">Saldo em aberto</td>
              <td style="border-top:1px solid #dfe3eb;color:#6d28d9;font-size:15px;font-weight:800;text-align:right;padding:10px 0 0;white-space:nowrap;">${money.format(account.amount)}</td>
            </tr>
          </table>

          <div style="border-top:1px solid #e4e7ee;margin-top:16px;padding-top:14px;">
            <p style="color:#6d28d9;font-size:13px;font-weight:700;margin:0 0 12px;">Compras que formam este acerto</p>
            <div>
              <p style="color:#626b7c;font-size:12px;font-weight:700;margin:0 0 4px;">Valores que você deve</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${purchaseRows(account.charges)}</table>
              ${
                account.credits.length > 0
                  ? `<p style="color:#626b7c;font-size:12px;font-weight:700;margin:16px 0 4px;">Valores usados na compensação</p>
                     <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${purchaseRows(account.credits)}</table>`
                  : ""
              }
            </div>
          </div>
        </div>`;
    })
    .join("");

  const subject = `Acerto de contas em aberto: ${money.format(total)}`;
  const html = `
    <!doctype html>
    <html lang="pt-BR">
      <body style="background:#0e1320;margin:0;padding:0;">
        <div style="background:#0e1320;padding:32px 14px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
          <div style="max-width:560px;margin:0 auto;">
            <div style="padding:4px 6px 18px;">
              <p style="color:#a78bfa;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin:0 0 10px;">Casa Cinco • Acerto de contas</p>
              <h1 style="color:#ffffff;font-size:25px;letter-spacing:-.02em;margin:0 0 10px;">Olá, ${firstName}!</h1>
              <p style="color:#b7bfce;font-size:14px;line-height:1.6;margin:0;">
                Estes são os seus acertos de compras que ainda possuem valor a pagar. O cálculo já considera as dívidas nos dois sentidos e pagamentos aguardando confirmação.
              </p>
            </div>

            <div style="background:#171d2c;border:1px solid #2b3345;border-radius:16px;padding:18px 20px;margin-bottom:16px;">
              <p style="color:#9da7ba;font-size:12px;margin:0 0 4px;">Total em aberto</p>
              <p style="color:#ffffff;font-size:30px;font-weight:800;letter-spacing:-.03em;margin:0;">${money.format(total)}</p>
              <p style="color:#9da7ba;font-size:12px;margin:8px 0 0;">${accounts.length} ${accounts.length === 1 ? "pessoa para receber" : "pessoas para receber"}</p>
            </div>

            ${accountCards}

            <div style="text-align:center;padding:10px 0 6px;">
              <a href="${escapeHtml(appUrl.replace(/\/$/, ""))}/app/eu" style="display:inline-block;background:#7c3aed;border-radius:11px;color:#ffffff;font-size:14px;font-weight:700;padding:13px 22px;text-decoration:none;">Abrir meus acertos no site</a>
              <p style="color:#747e91;font-size:11px;line-height:1.5;margin:18px auto 0;max-width:440px;">
                Os valores refletem o estado do site no momento deste envio. Se você já pagou, anexe o comprovante para que o recebedor ou administrador confirme.
              </p>
            </div>
          </div>
        </div>
      </body>
    </html>`;

  return { subject, html };
}
