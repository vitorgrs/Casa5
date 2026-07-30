"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function target(message: string, mode: "error" | "success" = "error") {
  return `/login?${mode}=${encodeURIComponent(message)}`;
}

export async function login(formData: FormData) {
  const supabase = await createClient();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(target("E-mail ou senha inválidos."));
  redirect("/app");
}

export async function signup(formData: FormData) {
  const supabase = await createClient();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: `${appUrl}/auth/callback`
    }
  });

  if (error) redirect(target(error.message));
  redirect(target("Conta criada. Confirme o e-mail e aguarde a liberação do acesso.", "success"));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
