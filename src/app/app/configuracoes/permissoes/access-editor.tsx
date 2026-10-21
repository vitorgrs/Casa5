"use client";

import { useMemo, useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import {
  PAGE_CATALOG,
  PAGE_KEYS,
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  PERMISSION_PAGE,
  type PageKey,
  type PermissionKey,
} from "@/lib/permissions";
import { updatePermissions } from "../actions";

type Preset = "all" | "view_only";

export function AccessEditor({
  profileId,
  firstName,
  initialPermissions,
  initialHiddenPages,
}: {
  profileId: string;
  firstName: string;
  initialPermissions: PermissionKey[];
  initialHiddenPages: PageKey[];
}) {
  const [granted, setGranted] = useState(() => new Set(initialPermissions));
  const [visible, setVisible] = useState(
    () => new Set(PAGE_KEYS.filter((key) => !initialHiddenPages.includes(key))),
  );

  // Permissão concedida numa página oculta não tem onde ser usada.
  const unreachable = useMemo(
    () =>
      PERMISSION_KEYS.filter(
        (key) => granted.has(key) && !visible.has(PERMISSION_PAGE[key]),
      ),
    [granted, visible],
  );

  function toggle<T>(set: Set<T>, value: T, update: (next: Set<T>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  }

  function applyPreset(preset: Preset) {
    setGranted(new Set(preset === "all" ? PERMISSION_KEYS : []));
    setVisible(new Set(PAGE_KEYS));
  }

  function setGroup(keys: readonly PermissionKey[], enabled: boolean) {
    const next = new Set(granted);
    keys.forEach((key) => (enabled ? next.add(key) : next.delete(key)));
    setGranted(next);
  }

  return (
    <form action={updatePermissions} className="access-editor">
      <input type="hidden" name="profile_id" value={profileId} />
      <input type="hidden" name="redirect_to" value="/app/configuracoes/permissoes" />

      <div className="access-presets" role="group" aria-label="Atalhos de acesso">
        <span>Atalhos:</span>
        <button type="button" className="button ghost small" onClick={() => applyPreset("view_only")}>
          Somente visualizar
        </button>
        <button type="button" className="button ghost small" onClick={() => applyPreset("all")}>
          Tudo liberado
        </button>
      </div>

      <div className="access-columns">
        <fieldset className="access-fieldset">
          <legend>
            Funcionalidades <small>{granted.size} de {PERMISSION_KEYS.length}</small>
          </legend>
          {PERMISSION_GROUPS.map((group) => {
            const keys = group.permissions.map((permission) => permission.key);
            const allOn = keys.every((key) => granted.has(key));
            return (
              <div className="access-group" key={group.key}>
                <div className="access-group-head">
                  <strong>{group.label}</strong>
                  <button
                    type="button"
                    className="access-group-toggle"
                    onClick={() => setGroup(keys, !allOn)}
                  >
                    {allOn ? "Desmarcar grupo" : "Marcar grupo"}
                  </button>
                </div>
                <div className="permission-grid">
                  {group.permissions.map((permission) => (
                    <label className="permission-row" key={permission.key}>
                      <input
                        type="checkbox"
                        name={`perm_${permission.key}`}
                        checked={granted.has(permission.key)}
                        onChange={() => toggle(granted, permission.key, setGranted)}
                      />
                      <span>
                        <strong>{permission.label}</strong>
                        <small>{permission.description}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </fieldset>

        <fieldset className="access-fieldset">
          <legend>
            Páginas visíveis <small>{visible.size} de {PAGE_KEYS.length}</small>
          </legend>
          <p className="note">
            Páginas desmarcadas somem do menu e, se abertas pelo endereço, levam
            para a primeira página permitida.
          </p>
          <div className="permission-grid">
            {PAGE_CATALOG.map((page) => (
              <label className="permission-row access-page-row" key={page.key}>
                <input
                  type="checkbox"
                  name={`page_${page.key}`}
                  checked={visible.has(page.key)}
                  onChange={() => toggle(visible, page.key, setVisible)}
                />
                <span>
                  <strong>{page.label}</strong>
                  <small>{page.href}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {unreachable.length > 0 && (
        <div className="message info" role="status">
          {unreachable.length === 1 ? "Uma permissão está" : `${unreachable.length} permissões estão`}{" "}
          numa página oculta e não poderá ser usada até a página voltar a ficar visível.
        </div>
      )}
      {visible.size === 0 && (
        <div className="message error" role="status">
          Sem nenhuma página visível, {firstName} verá apenas um aviso de acesso restrito.
        </div>
      )}

      <SubmitButton pendingLabel="Salvando...">
        Salvar acesso de {firstName}
      </SubmitButton>
    </form>
  );
}
