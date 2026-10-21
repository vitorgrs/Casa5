import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function loginWithError(origin: string, message: string) {
  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent(message)}`,
  );
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // O Supabase devolve o motivo na URL quando o link expirou ou já foi usado.
  const providerError = searchParams.get("error_description");
  if (providerError) return loginWithError(origin, providerError);
  if (!code) return NextResponse.redirect(`${origin}/app`);

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return loginWithError(
      origin,
      "Não foi possível confirmar o link. Ele pode ter expirado; entre com e-mail e senha.",
    );
  }
  return NextResponse.redirect(`${origin}/app`);
}
