import type { FormActionState } from "@/lib/form-action-state";

export function FormActionMessage({
  state,
  inline = false,
}: {
  state: FormActionState;
  inline?: boolean;
}) {
  if (state.status === "idle") return null;

  return (
    <div
      className={`message ${state.status} ${inline ? "inline-action-message" : ""}`}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </div>
  );
}
