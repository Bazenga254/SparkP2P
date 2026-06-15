// Central registry of blog posts. Add a new entry here (and its route + page component)
// and it automatically appears on /blog and can be added to sitemap.xml.
// Order: newest first.
export const POSTS = [
  {
    slug: 'binance-p2p-bot-kenya',
    path: '/binance-p2p-bot-kenya',
    title: 'Binance P2P Bot for Kenya: Automate Trading with M-Pesa & PesaLink',
    excerpt: 'What a Binance P2P bot does, how SparkP2P verifies M-Pesa and PesaLink payments, how it compares to manual trading and open-source scripts, safety, and pricing — for Kenyan merchants.',
    badge: 'Guide',
    date: '2026-06-15',
    readMins: 6,
  },
  {
    slug: 'automate-binance-p2p-mpesa',
    path: '/automate-binance-p2p-mpesa',
    title: 'How to Automate Binance P2P Trading with M-Pesa & PesaLink in Kenya',
    excerpt: 'A practical, no-code guide to automating Binance P2P payment verification and crypto release with M-Pesa and PesaLink — set up in under 10 minutes.',
    badge: 'How-To',
    date: '2026-06-15',
    readMins: 5,
  },
];

export function formatPostDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
