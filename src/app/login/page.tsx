import { login, signup } from "./actions";
import { Logo } from "@/components/logo";
import { CheckIcon, SparkIcon, WalletIcon } from "@/components/icons";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const params = await searchParams;
  return (
    <main className="auth-page">
      <section className="auth-showcase">
        <div className="auth-showcase-inner">
          <Logo />
          <div className="hero-copy">
            <span className="eyebrow bright">A casa organizada, sem planilha perdida</span>
            <h1>Contas, pagamentos e rotina em um só lugar.</h1>
            <p>Um painel privado para os cinco moradores acompanharem tudo. Somente o Vitor administra e altera os dados.</p>
          </div>
          <div className="feature-grid">
            <div className="feature-card"><WalletIcon/><strong>Finanças claras</strong><span>Divisão igual ou personalizada, por mês.</span></div>
            <div className="feature-card"><SparkIcon/><strong>Limpeza gamificada</strong><span>Pontos, sequência e ranking da casa.</span></div>
            <div className="feature-card"><CheckIcon/><strong>Sem cobrança confusa</strong><span>Status individual e alertas de vencimento.</span></div>
          </div>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <span className="eyebrow">Acesso privado</span>
          <h2>Entre na Casa Cinco</h2>
          <p className="muted-text">Use o e-mail cadastrado para acompanhar as despesas e tarefas.</p>
          {params.error && <div className="message error">{params.error}</div>}
          {params.success && <div className="message success">{params.success}</div>}
          <form action={login} className="stack-form">
            <label>E-mail<input name="email" type="email" required placeholder="voce@email.com" /></label>
            <label>Senha<input name="password" type="password" required minLength={8} placeholder="••••••••" /></label>
            <button className="button primary wide" type="submit">Entrar</button>
          </form>
          <details className="signup-details">
            <summary>Primeiro acesso? Criar conta</summary>
            <form action={signup} className="stack-form compact-form">
              <label>Nome completo<input name="full_name" required placeholder="Seu nome" /></label>
              <label>E-mail<input name="email" type="email" required placeholder="voce@email.com" /></label>
              <label>Senha<input name="password" type="password" required minLength={8} placeholder="Mínimo de 8 caracteres" /></label>
              <button className="button secondary wide" type="submit">Solicitar acesso</button>
            </form>
          </details>
          <small className="security-note">Os dados ficam protegidos pelo Supabase e não são públicos.</small>
        </div>
      </section>
    </main>
  );
}
