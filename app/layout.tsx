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
  title: "InsightFlow · Local-first Image Screening",
  description: "连接本地图片、模型与第三方 API 的可恢复、可审计图像数据筛选工作台。",
  openGraph: {
    title: "InsightFlow · Local-first Image Screening",
    description: "在一个界面启动本地筛选、追踪任务进度、完成人工审核并导出可复现数据集。",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "InsightFlow · Local-first Image Screening",
    description: "Run locally. Review clearly. Export reproducibly.",
    images: ["/og.png"],
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
