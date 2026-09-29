import type { Metadata } from 'next';
import './globals.css';
import './extras.css';

export const metadata: Metadata = {
  title: '智能井盖检测系统',
  description: '智能井盖定位、姿态、水位与霍尔传感器综合监测平台。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
