import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Casa Cinco",
  description: "Gestão compartilhada de despesas, pagamentos e rotinas da casa."
};

// `resizes-content` faz o Android encolher a página quando o teclado abre,
// mantendo visíveis as ações fixas dos formulários.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#070a12",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
