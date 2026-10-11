import Link from "next/link";
import { CheckIcon, LaundryIcon, WaterIcon } from "@/components/icons";

type CasaEmDiaSection = "tarefas" | "lavanderia" | "agua";

const sections = [
  {
    key: "tarefas" as const,
    href: "/app/limpeza",
    label: "Tarefas do dia",
    icon: CheckIcon,
  },
  {
    key: "lavanderia" as const,
    href: "/app/limpeza/lavanderia",
    label: "Lavanderia",
    icon: LaundryIcon,
  },
  {
    key: "agua" as const,
    href: "/app/limpeza/agua",
    label: "Galão de água",
    icon: WaterIcon,
  },
];

export function CasaEmDiaTabs({ active }: { active: CasaEmDiaSection }) {
  return (
    <nav className="casa-em-dia-tabs" aria-label="Áreas do Casa em dia">
      {sections.map(({ key, href, label, icon: Icon }) => (
        <Link
          className={`casa-em-dia-tab ${active === key ? "active" : ""}`}
          href={href}
          aria-current={active === key ? "page" : undefined}
          key={key}
        >
          <Icon />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
