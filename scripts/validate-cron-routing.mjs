import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const port = 3219;
const baseUrl = `http://127.0.0.1:${port}`;
const cronSecret = "cron-routing-test-secret";
const nextEnvPath = new URL("../next-env.d.ts", import.meta.url);
const originalNextEnv = await readFile(nextEnvPath, "utf8").catch(() => null);

// Estes valores impedem que a validação alcance o Supabase ou um provedor de
// e-mail reais, mesmo que existam credenciais válidas no .env.local.
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CRON_SECRET: cronSecret,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "routing-test-publishable-key",
      // Faz createServiceClient falhar dentro do handler, antes de qualquer
      // consulta, gravação ou preparação de destinatários.
      SUPABASE_SERVICE_ROLE_KEY: "",
      NEXT_PUBLIC_APP_URL: baseUrl,
      EMAIL_PROVIDER: "disabled-for-routing-test",
      RESEND_API_KEY: "",
      BREVO_API_KEY: "",
      MERCADO_PAGO_ACCESS_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let serverOutput = "";
child.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});
child.stderr.on("data", (chunk) => {
  serverOutput += String(chunk);
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path = "/api/cron/morning", headers) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // A asserção abaixo produz uma mensagem mais útil que o erro do JSON.parse.
  }
  return {
    status: response.status,
    contentType,
    location: response.headers.get("location"),
    body,
  };
}

async function waitUntilReady() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError ?? new Error("O servidor local não ficou pronto.");
}

try {
  const withoutToken = await waitUntilReady();
  assert(withoutToken.status === 401, `Sem token: esperado 401, recebido ${withoutToken.status}.`);
  assert(withoutToken.contentType.includes("application/json"), "Sem token: resposta não é JSON.");
  assert(withoutToken.location === null, "Sem token: a requisição foi redirecionada.");
  assert(withoutToken.body?.error === "Não autorizado", "Sem token: payload inesperado.");

  const dailyWithoutToken = await request("/api/cron/daily");
  assert(
    dailyWithoutToken.status === 401,
    `Cron diário sem token: esperado 401, recebido ${dailyWithoutToken.status}.`,
  );
  assert(
    dailyWithoutToken.contentType.includes("application/json") &&
      dailyWithoutToken.location === null,
    "Cron diário sem token: resposta não foi JSON direto.",
  );

  const withToken = await request("/api/cron/morning", {
    authorization: `Bearer ${cronSecret}`,
  });
  assert(withToken.status === 500, `Com token: esperado 500 controlado, recebido ${withToken.status}.`);
  assert(withToken.contentType.includes("application/json"), "Com token: resposta não é JSON.");
  assert(withToken.location === null, "Com token: a requisição foi redirecionada.");
  assert(withToken.body?.ok === false, "Com token: o handler não devolveu o erro controlado esperado.");
  assert(
    withToken.body?.error === "SUPABASE_SERVICE_ROLE_KEY não configurada.",
    "Com token: a resposta não veio de createServiceClient dentro do handler.",
  );

  const dailyWithToken = await request("/api/cron/daily", {
    authorization: `Bearer ${cronSecret}`,
  });
  assert(
    dailyWithToken.status === 500 &&
      dailyWithToken.contentType.includes("application/json") &&
      dailyWithToken.location === null &&
      dailyWithToken.body?.ok === false &&
      dailyWithToken.body?.error === "SUPABASE_SERVICE_ROLE_KEY não configurada.",
    "Cron diário com token: a requisição não chegou ao handler como esperado.",
  );

  console.log(
    JSON.stringify(
      {
        withoutToken: {
          status: withoutToken.status,
          json: true,
          redirectedToLogin: false,
        },
        dailyWithoutToken: {
          status: dailyWithoutToken.status,
          json: true,
          redirectedToLogin: false,
        },
        withToken: {
          status: withToken.status,
          json: true,
          reachedHandler: true,
          realDatabaseUsed: false,
          emailProviderEnabled: false,
        },
        dailyWithToken: {
          status: dailyWithToken.status,
          json: true,
          reachedHandler: true,
          realDatabaseUsed: false,
          emailProviderEnabled: false,
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (serverOutput) console.error(serverOutput.slice(-4_000));
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (originalNextEnv !== null) {
    await writeFile(nextEnvPath, originalNextEnv);
  }
}
