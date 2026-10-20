import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Broko AI Operations",
  description: "Operations dashboard for Broko Realty Ltd",
  robots: { index: false, follow: false },
};

// viewport-fit=cover lets the layout use the full screen on notched phones; safe-area padding is
// applied where content could sit under the notch or home indicator. No maximum-scale: users can zoom.
// (The Create/Edit dialog follows the on-screen keyboard itself via the visual viewport API.)
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
