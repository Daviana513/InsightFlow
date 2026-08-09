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
  title: "InsightFlow · Reproducible Data Screening",
  description: "面向传播研究者的可复现 AI 数据筛选与人工复核工作台。",
  openGraph: {
    title: "InsightFlow · Reproducible Data Screening",
    description: "把 AI 初筛、人工纠正与来源检查连接成可复现的研究工作流。",
    images: [{ url: "/insightflow-social.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "InsightFlow · Reproducible Data Screening",
    description: "把 AI 初筛、人工纠正与来源检查连接成可复现的研究工作流。",
    images: ["/insightflow-social.png"],
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
