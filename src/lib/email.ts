/**
 * Lembretes de vencimento por e-mail usando a API do Resend.
 *
 * Viabilidade: sim, é totalmente viável rodar isso na Vercel + Supabase.
 * O plano gratuito do Resend permite 3.000 e-mails/mês e 100/dia, o que é
 * muito mais do que uma casa de 5 pessoas precisa (no pior caso, ~5
 * despesas em aberto x 5 moradores x 1 lembrete/dia = 25 e-mails/dia).
 * A única exigência real é verificar um domínio de envio no Resend
 * (Domains > Add Domain) para poder mandar para qualquer destinatário;
 * sem domínio verificado, o Resend só permite testes com o endereço da
 * própria conta. Depois de verificado, defina as variáveis de ambiente:
 *   RESEND_API_KEY=re_...
 *   RESEND_FROM="Casa Cinco <avisos@seudominio.com>"
 * Se essas variáveis não existirem, os lembretes ficam desativados sem
 * quebrar o restante do app.
 */

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
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
  return Number.isNaN(date.getTime())
    ? "Data não informada"
    : date.toLocaleDateString("pt-BR");
}

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

export async function sendEmail({ to, subject, html }: SendEmailInput) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    throw new Error("RESEND_API_KEY ou RESEND_FROM não configurados.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from, to, subject, html })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend ${response.status}: ${body.slice(0, 500)}`);
  }

  return (await response.json()) as { id: string };
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
