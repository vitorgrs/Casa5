import Link from "next/link";
import { SettingsIcon } from "@/components/icons";
import { requireActiveProfile } from "@/lib/auth";
import { firstVisiblePage } from "@/lib/permissions";

export default async function NoAccessPage() {
  const { profile } = await requireActiveProfile();
  const destination = firstVisiblePage(profile);

  return (
    <div className="card pad" style={{ maxWidth: 560 }}>
      <span className="eyebrow">Acesso restrito</span>
      <h1 style={{ marginTop: 8 }}>Nenhuma página liberada</h1>
      <p className="note">
        O administrador ainda não liberou páginas para o seu perfil. Peça a ele
        para ajustar o seu acesso em Configurações → Acesso dos moradores.
      </p>
      {destination && (
        <Link className="button secondary" href={destination}>
          <SettingsIcon /> Ir para a primeira página liberada
        </Link>
      )}
    </div>
  );
}
