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
    const wrongSeparator = Boolean(current.separator && current.separator !== ",");

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

function toMercadoPagoUtcIso(date: Date) {
  // A API documenta o formato UTC sem milissegundos, por exemplo:
  // 2019-05-01T00:00:00Z.
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type GenerateReportResult = {
  status: number;
  accepted: boolean;
  detail: string | null;
};

/**
 * BUG ENCONTRADO: a função antiga sempre lia `response.ok`, que é `true`
 * para qualquer status 2xx. A documentação oficial do Mercado Pago avisa
 * que o endpoint de criação pode responder `202` (aceito, relatório será
 * gerado) OU `203 Non-Authoritative Information` — que significa "a
 * requisição foi entendida, mas o relatório NÃO pôde ser criado; peça
 * novamente com as datas indicadas pelo sistema". Como 203 também é um
 * status 2xx, o código antigo tratava isso como sucesso silenciosamente,
 * então o relatório nunca era realmente criado e o app ficava repetindo
 * "nova atualização solicitada" para sempre.
 * Agora tratamos 202 e 203 de forma explícita e devolvemos o motivo real
 * para a tela de Configurações.
 */
export async function generateBankReport(days = 35): Promise<GenerateReportResult> {
  // O relatório de Liberações aceita no máximo 60 dias.
  const safeDays = Math.min(Math.max(Math.trunc(days), 1), 59);
  const end = new Date();
  const begin = new Date(end);
  begin.setUTCDate(begin.getUTCDate() - safeDays);

  const payload = {
    begin_date: toMercadoPagoUtcIso(begin),
    end_date: toMercadoPagoUtcIso(end)
  };

  const response = await fetch(`${BASE_URL}${RELEASE_REPORT_PATH}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
    cache: "no-store"
  });

  const bodyText = await response.text();

  if (response.status === 202) {
    return { status: 202, accepted: true, detail: null };
  }

  if (response.status === 203) {
    // A API costuma devolver, no corpo, uma sugestão de datas válidas.
    return { status: 203, accepted: false, detail: bodyText.slice(0, 500) || "O Mercado Pago recusou o intervalo de datas solicitado." };
  }

  if (!response.ok) {
    throw new Error(`Mercado Pago ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  return { status: response.status, accepted: true, detail: null };
}

type ReportTask = {
  id: number;
  generation_date?: string;
  last_modified?: string;
  begin_date: string;
  end_date: string;
  status?: string;
};

type ReadyReport = {
  id: number;
  file_name: string;
  date_created?: string;
  download_date?: string;
  begin_date: string;
  end_date: string;
  status?: string;
};

type SearchReportsResponse = {
  results?: ReadyReport[];
};

type DatedReport = ReportTask | ReadyReport;

function reportTimestamp(report: DatedReport) {
  const reportWithDates = report as DatedReport & {
    date_created?: string;
    generation_date?: string;
    last_modified?: string;
  };
  const value =
    reportWithDates.date_created ??
    reportWithDates.generation_date ??
    reportWithDates.last_modified ??
    report.end_date;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * O formato de `/list` varia entre contas: ele pode expor tarefas de geração
 * (`pending`/`processed`) ou registros já habilitados. Aqui ele serve apenas
 * para detectar a atividade mais recente, nunca para escolher o download.
 */
export async function listBankReportTasks(): Promise<ReportTask[]> {
  const response = await mpFetch(`${RELEASE_REPORT_PATH}/list`);
  const data = (await response.json()) as ReportTask[];
  return [...data].sort((a, b) => reportTimestamp(b) - reportTimestamp(a));
}

/**
 * `/search` possui o contrato estável dos arquivos prontos: resposta paginada
 * em `results`, com o `file_name` necessário para o download.
 */
export async function listBankReports(): Promise<ReadyReport[]> {
  const response = await mpFetch(
    `${RELEASE_REPORT_PATH}/search?limit=100&offset=0`,
  );
  const data = (await response.json()) as SearchReportsResponse | ReadyReport[];
  const reports = Array.isArray(data) ? data : (data.results ?? []);
  return reports
    .filter((report) => Boolean(report.file_name))
    .sort((a, b) => reportTimestamp(b) - reportTimestamp(a));
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

  if (
    rows.length === 0 ||
    !rows.some(
      (row) =>
        "BALANCE_AMOUNT" in row ||
        "NET_CREDIT_AMOUNT" in row ||
        "NET_DEBIT_AMOUNT" in row,
    )
  ) {
    throw new Error(
      "O Mercado Pago retornou um relatório vazio ou sem as colunas financeiras esperadas.",
    );
  }

  // A linha final `total` do CSV pode trazer BALANCE_AMOUNT=0,00 mesmo
  // quando a última movimentação tem saldo disponível. O saldo correto é o
  // BALANCE_AMOUNT mais recente de uma linha operacional.
  const rowsWithBalance = rows.filter(
    (row) =>
      row.BALANCE_AMOUNT?.trim() &&
      row.RECORD_TYPE?.trim().toLowerCase() !== "total",
  );
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
  const [tasks, reports] = await Promise.all([
    listBankReportTasks(),
    listBankReports(),
  ]);
  const latestReadyReport = reports[0];

  let imported = false;
  let balance: number | null = null;
  let requestDetail: string | null = null;

  if (latestReadyReport) {
    const latest = latestReadyReport;
    const fileName = latest.file_name;
    const { data: existing, error: existingError } = await supabase
      .from("wallet_snapshots")
      .select("id,balance")
      .eq("household_id", householdId)
      .eq("external_id", fileName)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);

    const result = await downloadAndCalculateBalance(fileName);
    const snapshot = {
      balance: result.balance,
      observed_at:
        result.lastMovementAt ?? latest.end_date ?? new Date().toISOString(),
      raw_payload: {
        report_id: latest.id,
        file_name: fileName,
        transactions: result.transactions,
        begin_date: latest.begin_date,
        end_date: latest.end_date,
      },
    };

    if (existing) {
      const existingCents = Math.round(Number(existing.balance) * 100);
      const calculatedCents = Math.round(result.balance * 100);
      if (existingCents !== calculatedCents) {
        // Repara snapshots criados pela versão antiga, que lia o zero da
        // linha `total` em vez do saldo da última movimentação.
        const { error } = await supabase
          .from("wallet_snapshots")
          .update(snapshot)
          .eq("id", existing.id);
        if (error) throw new Error(error.message);
        imported = true;
      }
      balance = result.balance;
    } else {
      const { error } = await supabase.from("wallet_snapshots").insert({
        household_id: householdId,
        ...snapshot,
        source: "mercado_pago",
        external_id: fileName,
        created_by: createdBy
      });
      if (error) throw new Error(error.message);
      imported = true;
      balance = result.balance;
    }
  }

  const newestTaskAt = tasks[0] ? reportTimestamp(tasks[0]) : 0;
  const newestReportAt = reports[0] ? reportTimestamp(reports[0]) : 0;
  const newestCreatedAt = Math.max(newestTaskAt, newestReportAt);
  const twentyHoursAgo = Date.now() - 20 * 60 * 60 * 1000;
  let requested = false;
  if (newestCreatedAt < twentyHoursAgo) {
    const result = await generateBankReport();
    requested = result.accepted;
    if (!result.accepted) {
      requestDetail = `O Mercado Pago recusou a solicitação (status ${result.status}). Detalhe: ${result.detail}`;
    }
  }

  return {
    imported,
    balance,
    reportsFound: tasks.length,
    readyReportsFound: reports.length,
    requested,
    requestDetail,
    latestReportReady: Boolean(reports[0]),
    latestTaskStatus: tasks[0]?.status ?? null,
    latestReportDate: newestCreatedAt
      ? new Date(newestCreatedAt).toISOString()
      : null,
  };
}
