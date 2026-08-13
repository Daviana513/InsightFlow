import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "InsightFlow · Human Review Agent",
  description: "连接本地图片与候选 CSV 的多阶段人工审核、对比和数据打标工作台。",
  openGraph: {
    title: "InsightFlow · Human Review Agent",
    description: "审核图片与帖文上下文，保存人工证据，导出可恢复、可审计的研究数据。",
    images: [{ url: "/og-review-agent.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "InsightFlow · Human Review Agent",
    description: "Review locally. Label clearly. Export reproducibly.",
    images: ["/og-review-agent.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
