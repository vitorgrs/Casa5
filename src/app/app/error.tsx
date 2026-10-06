"use client";

import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Falha ao carregar a área autenticada", error);
  }, [error]);

  return (
    <section className="card pad app-error-card" role="alert">
      <span className="eyebrow">Não foi possível concluir</span>
      <h1>Algo interrompeu esta atualização.</h1>
      <p className="muted-text">
        Seus dados podem já ter sido salvos. Tente carregar novamente antes de
        repetir o cadastro para evitar duplicidade.
      </p>
      <div className="form-actions">
        <button className="button primary" type="button" onClick={reset}>
          Carregar novamente
        </button>
        <button
          className="button ghost"
          type="button"
          onClick={() => window.location.reload()}
        >
          Atualizar página
        </button>
      </div>
      {error.digest && <small className="muted-text">Código: {error.digest}</small>}
    </section>
  );
}
