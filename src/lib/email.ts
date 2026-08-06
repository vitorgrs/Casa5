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
