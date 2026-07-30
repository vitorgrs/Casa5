import { parseCsv } from "@/lib/csv";

const BASE_URL = "https://api.mercadopago.com";

function headers() {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!token) throw new Error("MERCADO_PAGO_ACCESS_TOKEN não configurado.");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}

async function mpFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...headers(), ...(init?.headers ?? {}) },
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mercado Pago ${response.status}: ${body.slice(0, 300)}`);
  }

  return response;
}

export async function ensureBankReportConfig() {
  const check = await fetch(`${BASE_URL}/v1/account/bank_report/config`, {
    headers: headers(),
    cache: "no-store"
  });

  const payload = {
    file_name_prefix: "casa5-saldo",
    include_withdrawal_at_end: false,
    execute_after_withdrawal: false,
    separator: ",",
    display_timezone: "GMT-03",
    columns: [
      { key: "DATE" },
      { key: "SOURCE_ID" },
      { key: "EXTERNAL_REFERENCE" },
      { key: "RECORD_TYPE" },
      { key: "DESCRIPTION" },
      { key: "NET_CREDIT_AMOUNT" },
      { key: "NET_DEBIT_AMOUNT" },
      { key: "GROSS_AMOUNT" },
      { key: "PAYMENT_METHOD" }
    ]
  };

  if (check.ok) return;

  await mpFetch("/v1/account/bank_report/config", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function generateBankReport(days = 35) {
  const end = new Date();
  const begin = new Date(end);
  begin.setDate(begin.getDate() - days);

  await mpFetch("/v1/account/bank_report", {
    method: "POST",
    body: JSON.stringify({ begin_date: begin.toISOString(), end_date: end.toISOString() })
  });
}

type ReportItem = {
  id: number;
  file_name: string;
  date_created: string;
  begin_date: string;
  end_date: string;
};

export async function listBankReports(): Promise<ReportItem[]> {
  const response = await mpFetch("/v1/account/bank_report/list");
  const data = (await response.json()) as ReportItem[];
  return [...data].sort((a, b) => Date.parse(b.date_created) - Date.parse(a.date_created));
}

export async function downloadAndCalculateBalance(fileName: string) {
  const response = await mpFetch(`/v1/account/bank_report/${encodeURIComponent(fileName)}`);
  const csv = await response.text();
  const rows = parseCsv(csv);

  const balance = rows.reduce((total, row) => {
    const credit = Number((row.NET_CREDIT_AMOUNT || "0").replace(",", ".")) || 0;
    const debit = Number((row.NET_DEBIT_AMOUNT || "0").replace(",", ".")) || 0;
    return total + credit - debit;
  }, 0);

  return {
    balance: Math.round(balance * 100) / 100,
    transactions: rows.length,
    lastMovementAt: rows.at(-1)?.DATE ?? null
  };
}

export async function syncLatestMercadoPagoReport(
  supabase: import("@supabase/supabase-js").SupabaseClient,
  householdId: string,
  createdBy: string | null = null
) {
  await ensureBankReportConfig();
  const reports = await listBankReports();
  let imported = false;
  let balance: number | null = null;

  if (reports.length > 0) {
    const latest = reports[0];
    const { data: existing } = await supabase
      .from("wallet_snapshots")
      .select("id,balance")
      .eq("external_id", latest.file_name)
      .maybeSingle();

    if (existing) {
      balance = Number(existing.balance);
    } else {
      const result = await downloadAndCalculateBalance(latest.file_name);
      const { error } = await supabase.from("wallet_snapshots").insert({
        household_id: householdId,
        balance: result.balance,
        source: "mercado_pago",
        external_id: latest.file_name,
        observed_at: result.lastMovementAt ?? latest.end_date ?? new Date().toISOString(),
        raw_payload: {
          report_id: latest.id,
          file_name: latest.file_name,
          transactions: result.transactions,
          begin_date: latest.begin_date,
          end_date: latest.end_date
        },
        created_by: createdBy
      });
      if (error) throw new Error(error.message);
      imported = true;
      balance = result.balance;
    }
  }

  const newestCreatedAt = reports[0]?.date_created ? Date.parse(reports[0].date_created) : 0;
  const twentyHoursAgo = Date.now() - 20 * 60 * 60 * 1000;
  if (newestCreatedAt < twentyHoursAgo) await generateBankReport();
  return { imported, balance, reportsFound: reports.length };
}
