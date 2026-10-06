import { parseCsv } from "@/lib/csv";

const BASE_URL = "https://api.mercadopago.com";
const RELEASE_REPORT_PATH = "/v1/account/release_report";
const MERCADO_PAGO_TIMEOUT_MS = 10_000;
const REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PENDING_REQUEST_DEDUPE_MS = 90 * 60 * 1000;
const BALANCE_PARSER_VERSION = 3;

function headers() {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!token) throw new Error("MERCADO_PAGO_ACCESS_TOKEN não configurado.");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}

async function mercadoPagoFetch(path: string, init?: RequestInit) {
  try {
    return await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...headers(), ...(init?.headers ?? {}) },
      cache: "no-store",
      signal: init?.signal ?? AbortSignal.timeout(MERCADO_PAGO_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new Error(
        "O Mercado Pago demorou para responder. Tente sincronizar novamente em alguns instantes.",
      );
    }
    throw error;
  }
}

async function mpFetch(path: string, init?: RequestInit) {
  const response = await mercadoPagoFetch(path, init);

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
  include_withdrawal_at_end?: boolean;
  check_available_balance?: boolean;
  compensate_detail?: boolean;
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
  const check = await mercadoPagoFetch(`${RELEASE_REPORT_PATH}/config`);

  if (check.ok) {
    const current = (await check.json()) as ReportConfig;
    const currentColumns = new Set((current.columns ?? []).map((column) => column.key));
    const missingColumns = requiredColumns.some((column) => !currentColumns.has(column));
    const wrongSeparator = Boolean(current.separator && current.separator !== ",");
    const missingBalanceOptions =
      current.include_withdrawal_at_end !== true ||
      current.check_available_balance !== true ||
      current.compensate_detail !== true;

    if (!missingColumns && !wrongSeparator && !missingBalanceOptions) return;

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

// A criação é assíncrona: 202 confirma que o relatório entrou na fila. O 203
// também pertence à faixa 2xx, mas informa que o intervalo foi recusado; por
// isso ele precisa ser tratado separadamente e exibido ao administrador.
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

  const response = await mercadoPagoFetch(RELEASE_REPORT_PATH, {
    method: "POST",
    body: JSON.stringify(payload),
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

function reportCoverageTimestamp(report: DatedReport) {
  const timestamp = Date.parse(report.end_date);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isPendingTask(task: ReportTask) {
  const status = task.status?.toLowerCase();
  return status === "pending" || status === "processing" || status === "in_process";
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
    .sort(
      (a, b) =>
        reportCoverageTimestamp(b) - reportCoverageTimestamp(a) ||
        reportTimestamp(b) - reportTimestamp(a),
    );
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

function rowTimestamp(row: Record<string, string>) {
  const timestamp = Date.parse(row.DATE?.trim() ?? "");
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function mostRecentRow(rows: Record<string, string>[]) {
  return rows.reduce<Record<string, string> | undefined>((latest, row) => {
    if (!latest || rowTimestamp(row) >= rowTimestamp(latest)) return row;
    return latest;
  }, undefined);
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
  // Embora os relatórios atuais sejam normalmente cronológicos, escolhemos
  // pela coluna DATE para não depender da ordem física recebida no CSV. Em
  // caso de empate, a última linha daquele instante vence (por exemplo, o
  // `post_payout` depois do débito do saque).
  const lastBalanceRow = mostRecentRow(rowsWithBalance);

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

  const lastMovement = mostRecentRow(
    rows.filter(
      (row) => row.DATE?.trim() && row.RECORD_TYPE?.toLowerCase() !== "total",
    ),
  );

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
  let syncedAt: string | null = null;
  let snapshotCoverageAt = 0;

  if (latestReadyReport) {
    const latest = latestReadyReport;
    const fileName = latest.file_name;
    const { data: existing, error: existingError } = await supabase
      .from("wallet_snapshots")
      .select("id,balance,observed_at,created_at,raw_payload")
      .eq("household_id", householdId)
      .eq("external_id", fileName)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existing?.observed_at) {
      const timestamp = Date.parse(existing.observed_at);
      snapshotCoverageAt = Number.isFinite(timestamp) ? timestamp : 0;
    }

    const rawPayload = existing?.raw_payload as
      | { parser_version?: number }
      | null;
    const needsImport =
      !existing || rawPayload?.parser_version !== BALANCE_PARSER_VERSION;

    if (needsImport) {
      const result = await downloadAndCalculateBalance(fileName);
      // `observed_at` representa até quando o relatório conferiu o saldo.
      // A última movimentação pode ser muito mais antiga e fica nos metadados.
      const observedAt =
        latest.end_date ?? latest.date_created ?? new Date().toISOString();
      const snapshot = {
        balance: result.balance,
        observed_at: observedAt,
        raw_payload: {
          parser_version: BALANCE_PARSER_VERSION,
          report_id: latest.id,
          file_name: fileName,
          transactions: result.transactions,
          begin_date: latest.begin_date,
          end_date: latest.end_date,
          report_created_at: latest.date_created ?? null,
          last_movement_at: result.lastMovementAt,
        },
      };

      if (existing) {
        const { error } = await supabase
          .from("wallet_snapshots")
          .update(snapshot)
          .eq("id", existing.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase.from("wallet_snapshots").insert({
          household_id: householdId,
          ...snapshot,
          source: "mercado_pago",
          external_id: fileName,
          created_by: createdBy,
        });
        if (error) throw new Error(error.message);
      }
      imported = true;
      balance = result.balance;
      syncedAt = new Date().toISOString();
      const observedTimestamp = Date.parse(observedAt);
      snapshotCoverageAt = Number.isFinite(observedTimestamp)
        ? observedTimestamp
        : 0;
    } else {
      balance = Number(existing.balance);
      syncedAt = existing.created_at;
    }
  } else {
    const { data: latestSnapshot, error: snapshotError } = await supabase
      .from("wallet_snapshots")
      .select("balance,observed_at,created_at")
      .eq("household_id", householdId)
      .eq("source", "mercado_pago")
      .order("observed_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (snapshotError) throw new Error(snapshotError.message);
    if (latestSnapshot) {
      balance = Number(latestSnapshot.balance);
      syncedAt = latestSnapshot.created_at;
      const timestamp = Date.parse(latestSnapshot.observed_at);
      snapshotCoverageAt = Number.isFinite(timestamp) ? timestamp : 0;
    }
  }

  const coverageAt = Math.max(
    latestReadyReport ? reportCoverageTimestamp(latestReadyReport) : 0,
    snapshotCoverageAt,
  );
  const stale = coverageAt < Date.now() - REPORT_MAX_AGE_MS;
  const recentPendingTask = tasks.find(
    (task) =>
      isPendingTask(task) &&
      reportTimestamp(task) >= Date.now() - PENDING_REQUEST_DEDUPE_MS,
  );
  let requested = false;
  if (stale && !recentPendingTask) {
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
    latestTaskStatus: recentPendingTask?.status ?? tasks[0]?.status ?? null,
    latestReportDate: coverageAt
      ? new Date(coverageAt).toISOString()
      : null,
    syncedAt,
    stale,
    pending: Boolean(recentPendingTask),
  };
}
