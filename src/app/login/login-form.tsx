"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(formData.get("password") ?? "");
    const supabase = createClient();

    try {
      const { error: signInError } = await Promise.race([
        supabase.auth.signInWithPassword({ email, password }),
        new Promise<never>((_, reject) =>
          window.setTimeout(
            () => reject(new Error("A conexão demorou mais do que o esperado.")),
            20_000,
          ),
        ),
      ]);
      if (signInError) {
        setError("E-mail ou senha inválidos.");
        return;
      }

      router.replace("/app");
      router.refresh();
    } catch (signInError) {
      setError(
        signInError instanceof Error
          ? signInError.message
          : "Não foi possível entrar. Verifique sua conexão e tente novamente.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack-form" onSubmit={handleSubmit}>
      {error && <div className="message error">{error}</div>}
      <label>
        E-mail
        <input
          name="email"
          type="email"
          required
          placeholder="voce@email.com"
          autoComplete="email"
        />
      </label>
      <label>
        Senha
        <input
          name="password"
          type="password"
          required
          minLength={8}
          placeholder="••••••••"
          autoComplete="current-password"
        />
      </label>
      <button className="button primary wide" type="submit" disabled={pending}>
        {pending ? "Entrando..." : "Entrar"}
      </button>
    </form>
  );
}
