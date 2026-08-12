export type FormActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const initialFormActionState: FormActionState = {
  status: "idle",
  message: "",
};
