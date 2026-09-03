import type { Metadata } from 'next';
import 'katex/dist/katex.min.css';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://radiation-2d-simulator.jmartin741572.chatgpt.site'),
  title: 'EM radiation 2D — Electromagnetic Field Simulator',
  description:
    'Explore how accelerating charges create electromagnetic radiation through an interactive two-dimensional field simulator.',
  openGraph: {
    type: 'website',
    url: '/',
    title: 'EM radiation 2D',
    description: 'Explore electromagnetic radiation from moving charges in real time.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'EM radiation 2D electromagnetic field simulator',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'EM radiation 2D',
    description: 'Explore electromagnetic radiation from moving charges in real time.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
