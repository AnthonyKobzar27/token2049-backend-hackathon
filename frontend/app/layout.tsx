import type { Metadata } from 'next';
import { Baloo_2, Quicksand } from 'next/font/google';
import './globals.css';

const display = Baloo_2({ subsets: ['latin'], weight: ['500', '600', '700', '800'], variable: '--font-display' });
const body = Quicksand({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-body' });

export const metadata: Metadata = {
  title: 'HumanRouter · agents think, we give them hands',
  description: 'The exit from the agent world into the human world: your agent searches, shortlists and books real people, with escrow and your approval.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} min-h-screen antialiased`}>{children}</body>
    </html>
  );
}
