import { MessageIcon } from "@/components/icons";
import { requirePage } from "@/lib/auth";
import { ComplaintForm } from "./complaint-form";

export const dynamic = "force-dynamic";

type Complaint = {
  id: string;
  protocol: string;
  subject: string;
  message: string;
  status: "under_review";
  created_at: string;
};

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

export default async function ComplaintsPage({
  searchParams,
}: {
  searchParams: Promise<{
    success?: string;
    error?: string;
    updated?: string;
  }>;
}) {
  const params = await searchParams;
  const { supabase } = await requirePage("complaints");
  const { data, error } = await supabase.rpc("list_my_anonymous_complaints");
  const complaints = ((data ?? []) as Complaint[]).sort(
    (first, second) =>
      new Date(second.created_at).getTime() - new Date(first.created_at).getTime(),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Canal confidencial</span>
          <h1>Reclamações anônimas</h1>
          <p>
            Registre uma situação da casa sem revelar sua identidade e acompanhe
            o protocolo por esta página.
          </p>
        </div>
        <div className="complaint-privacy-chip">
          <MessageIcon /> Sua identidade não aparece na reclamação
        </div>
      </div>

      {params.success && <div className="message success">{params.success}</div>}
      {params.error && <div className="message error">{params.error}</div>}
      {error && (
        <div className="message error">
          Não foi possível consultar seus protocolos: {error.message}
        </div>
      )}

      <div className="complaints-layout">
        <section className="card pad complaint-form-card">
          <div className="card-head complaint-card-head">
            <div>
              <h2>Fazer uma reclamação</h2>
              <span className="muted-text">
                Descreva o fato com clareza, sem informar seu nome no texto.
              </span>
            </div>
            <MessageIcon />
          </div>

          <ComplaintForm />
        </section>

        <section className="card complaint-history-card">
          <div className="card-head">
            <div>
              <h2>Acompanhamento</h2>
              <span className="muted-text">
                Somente as reclamações enviadas por você aparecem aqui.
              </span>
            </div>
            <span className="status-pill violet">{complaints.length}</span>
          </div>

          <div className="complaint-list">
            {complaints.map((complaint) => (
              <article className="complaint-row" key={complaint.id}>
                <div className="complaint-row-head">
                  <div>
                    <span className="eyebrow">{complaint.protocol}</span>
                    <h3>{complaint.subject}</h3>
                  </div>
                  <span className="status-pill warning">
                    Sendo analisada pelo administrador
                  </span>
                </div>
                <p>{complaint.message}</p>
                <small>Enviada em {dateTime.format(new Date(complaint.created_at))}</small>
              </article>
            ))}
            {complaints.length === 0 && !error && (
              <div className="empty">
                Você ainda não enviou nenhuma reclamação.
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
