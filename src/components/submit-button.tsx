"use client";

import { useFormStatus } from "react-dom";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  pendingLabel?: ReactNode;
  className?: string;
};

/**
 * Botão de submit que mostra estado de carregamento (e se desabilita)
 * enquanto a server action do formulário pai está rodando. Isso resolve a
 * sensação de "travado" quando a Vercel demora alguns segundos para
 * responder — o usuário passa a ver feedback imediato no clique.
 */
export function SubmitButton({ children, pendingLabel, className = "button primary", disabled, ...props }: Props) {
  const { pending } = useFormStatus();
  return (
    <button {...props} type="submit" className={className} disabled={pending || disabled}>
      {pending ? (
        <>
          <span className="spinner" aria-hidden="true" />
          {pendingLabel ?? "Salvando..."}
        </>
      ) : (
        children
      )}
    </button>
  );
}
