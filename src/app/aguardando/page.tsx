import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { Logo } from "@/components/logo";
import { ClockIcon } from "@/components/icons";
import { requireUser } from "@/lib/auth";

export default async function WaitingPage() {
  const { supabase, user } = await requireUser();
  const { data: profile } = await supabase.from("profiles").select("status").eq("id", user.id).single();
  if (profile?.status === "active") redirect("/app");

  return (
    <main className="center-page">
      <div className="waiting-card">
        <Logo />
        <div className="waiting-icon"><ClockIcon /></div>
        <h1>Acesso aguardando liberação</h1>
        <p>Sua conta foi criada, mas o Vitor ainda precisa associar seu e-mail a um dos cinco moradores.</p>
        <div className="message info">E-mail conectado: <strong>{user.email}</strong></div>
        <form action={signOut}><button className="button secondary">Sair</button></form>
      </div>
    </main>
  );
}
