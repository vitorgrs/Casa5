import { parseCsv } from "@/lib/csv";

const BASE_URL = "https://api.mercadopago.com";
const RELEASE_REPORT_PATH = "/v1/account/release_report";

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
    throw new Error(`Mercado Pago ${response.status}: ${body.slice(0, 500)}`);
  }

  return response;
}

const requiredColumns = [
  "DATE",
  "SOURCE_ID",
  "EXTERNAL_REFERENCE",
  "RECORD_TYPE",
  "DESCRIPTION",
  "NET_CREDIT_AMOUNT",
  "NET_DEBIT_AMOUNT",
  "GROSS_AMOUNT",
  "PAYMENT_METHOD",
  "BALANCE_AMOUNT"
];

type ReportConfig = {
  separator?: string;
  frequency?: { hour: number; type: "daily" | "weekly" | "monthly"; value?: number };
  columns?: Array<{ key: string }>;
};

function reportConfigPayload(current?: ReportConfig) {
  return {
    file_name_prefix: "casa5-saldo",
    include_withdrawal_at_end: true,
    execute_after_withdrawal: false,
    check_available_balance: true,
    compensate_detail: true,
    separator: ",",
    display_timezone: "GMT-03",
    frequency: current?.frequency ?? {
      hour: 8,
      type: "daily" as const
    },
    columns: requiredColumns.map((key) => ({ key }))
  };
}

/**
 * Mantém o nome antigo por compatibilidade com os imports do restante do projeto.
 * O endpoint correto atualmente é o relatório de Liberações (release_report).
 */
export async function ensureBankReportConfig() {
  const check = await fetch(`${BASE_URL}${RELEASE_REPORT_PATH}/config`, {
    headers: headers(),
    cache: "no-store"
  });

  if (check.ok) {
    const current = (await check.json()) as ReportConfig;
    const currentColumns = new Set((current.columns ?? []).map((column) => column.key));
    const missingColumns = requiredColumns.some((column) => !currentColumns.has(column));
    const wrongSeparator = current.separator !== ",";

    if (!missingColumns && !wrongSeparator) return;

    await mpFetch(`${RELEASE_REPORT_PATH}/config`, {
      method: "PUT",
      body: JSON.stringify(reportConfigPayload(current))
    });
    return;
  }

  // Sem configuração, a API costuma responder 400 ou 404. Outros erros, como
  // credencial inválida, devem ser exibidos em vez de tentar criar cegamente.
  if (check.status !== 400 && check.status !== 404) {
    const body = await check.text();
    throw new Error(`Mercado Pago ${check.status}: ${body.slice(0, 500)}`);
  }

  await mpFetch(`${RELEASE_REPORT_PATH}/config`, {
    method: "POST",
    body: JSON.stringify(reportConfigPayload())
  });
}

export async function generateBankReport(days = 35) {
  const end = new Date();
  const begin = new Date(end);
  begin.setDate(begin.getDate() - days);

  await mpFetch(RELEASE_REPORT_PATH, {
    method: "POST",
    body: JSON.stringify({ begin_date: begin.toISOString(), end_date: end.toISOString() })
  });
}

type ReportItem = {
  id: number;
  file_name?: string;
  date_created?: string;
  generation_date?: string;
  last_modified?: string;
  begin_date: string;
  end_date: string;
  status?: string;
};

function reportTimestamp(report: ReportItem) {
  const value = report.date_created ?? report.generation_date ?? report.last_modified ?? report.end_date;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function listBankReports(): Promise<ReportItem[]> {
  const response = await mpFetch(`${RELEASE_REPORT_PATH}/list`);
  const data = (await response.json()) as ReportItem[];
  return [...data].sort((a, b) => reportTimestamp(b) - reportTimestamp(a));
}

function parseMoney(value: string | undefined) {
  if (!value) return 0;
  const normalized = value.trim().replace(/\s/g, "");
  if (!normalized) return 0;

  // A API normalmente usa ponto decimal. Este tratamento também suporta
  // valores em formato brasileiro caso a configuração da conta os retorne.
  const decimal = normalized.includes(",") && normalized.includes(".")
    ? normalized.lastIndexOf(",") > normalized.lastIndexOf(".")
      ? normalized.replace(/\./g, "").replace(",", ".")
      : normalized.replace(/,/g, "")
    : normalized.includes(",")
      ? normalized.replace(",", ".")
      : normalized;

  const parsed = Number(decimal);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function downloadAndCalculateBalance(fileName: string) {
  const response = await mpFetch(`${RELEASE_REPORT_PATH}/${encodeURIComponent(fileName)}`);
  const csv = await response.text();
  const firstLine = csv.split(/\r?\n/, 1)[0] ?? "";
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows = parseCsv(csv.replace(/^\uFEFF/, ""), separator);

  const rowsWithBalance = rows.filter((row) => row.BALANCE_AMOUNT?.trim());
  const lastBalanceRow = rowsWithBalance.at(-1);

  let balance: number;
  if (lastBalanceRow) {
    balance = parseMoney(lastBalanceRow.BALANCE_AMOUNT);
  } else {
    const totalRow = rows.findLast((row) => row.RECORD_TYPE?.toLowerCase() === "total");
    if (totalRow) {
      balance = parseMoney(totalRow.NET_CREDIT_AMOUNT) - parseMoney(totalRow.NET_DEBIT_AMOUNT);
    } else {
      balance = rows.reduce((total, row) => {
        const recordType = row.RECORD_TYPE?.toLowerCase();
        if (recordType === "total" || recordType === "available_balance") return total;
        return total + parseMoney(row.NET_CREDIT_AMOUNT) - parseMoney(row.NET_DEBIT_AMOUNT);
      }, 0);
    }
  }

  const lastMovement = [...rows]
    .reverse()
    .find((row) => row.DATE?.trim() && row.RECORD_TYPE?.toLowerCase() !== "total");

  return {
    balance: Math.round(balance * 100) / 100,
    transactions: rows.length,
    lastMovementAt: lastMovement?.DATE ?? null
  };
}

export async function syncLatestMercadoPagoReport(
  supabase: import("@supabase/supabase-js").SupabaseClient,
  householdId: string,
  createdBy: string | null = null
) {
  await ensureBankReportConfig();
  const reports = await listBankReports();
  const latestReadyReport = reports.find(
    (report) => Boolean(report.file_name) && (!report.status || report.status === "processed")
  );

  let imported = false;
  let balance: number | null = null;

  if (latestReadyReport?.file_name) {
    const latest = latestReadyReport;
    const fileName = latest.file_name!;
    const { data: existing } = await supabase
      .from("wallet_snapshots")
      .select("id,balance")
      .eq("external_id", fileName)
      .maybeSingle();

    if (existing) {
      balance = Number(existing.balance);
    } else {
      const result = await downloadAndCalculateBalance(fileName);
      const { error } = await supabase.from("wallet_snapshots").insert({
        household_id: householdId,
        balance: result.balance,
        source: "mercado_pago",
        external_id: fileName,
        observed_at: result.lastMovementAt ?? latest.end_date ?? new Date().toISOString(),
        raw_payload: {
          report_id: latest.id,
          file_name: fileName,
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

  const newestCreatedAt = reports[0] ? reportTimestamp(reports[0]) : 0;
  const twentyHoursAgo = Date.now() - 20 * 60 * 60 * 1000;
  if (newestCreatedAt < twentyHoursAgo) await generateBankReport();

  return { imported, balance, reportsFound: reports.length };
}