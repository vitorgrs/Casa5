import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Os cron jobs da Vercel não possuem uma sessão de usuário. A autenticação
  // deles é feita dentro de cada route handler por meio do CRON_SECRET. Se o
  // proxy tentar exigir uma sessão aqui, a chamada automática é desviada para
  // /login e a rotina de e-mails nunca chega a executar.
  // A lista é intencionalmente fechada: uma nova rota sob /api/cron precisa
  // implementar a própria autenticação antes de ser liberada aqui.
  const isCronRoute =
    path === "/api/cron/morning" || path === "/api/cron/daily";
  if (isCronRoute) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
          // Cabeçalhos anti-cache enviados pelo @supabase/ssr impedem que uma
          // CDN guarde respostas com cookies de sessão renovados.
          Object.entries(headers ?? {}).forEach(([key, value]) =>
            response.headers.set(key, value)
          );
        }
      }
    }
  );

  // getClaims valida o JWT localmente (chaves assimétricas) e renova a sessão
  // perto da expiração, sem uma chamada ao Auth em toda navegação. As ações
  // sensíveis continuam usando getUser() em requireUser.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims ?? null;
  const publicPath = path === "/" || path.startsWith("/login") || path.startsWith("/auth/");

  if (!user && !publicPath) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    return NextResponse.redirect(url);
  }

  return response;
}
