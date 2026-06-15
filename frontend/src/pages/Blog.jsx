import { Link } from 'react-router-dom';
import ArticleLayout from '../components/ArticleLayout';
import { POSTS, formatPostDate } from '../data/posts';

const URL = 'https://sparkp2p.com/blog';

export default function Blog() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Blog',
        '@id': URL + '#blog',
        name: 'SparkP2P Blog',
        description: 'Guides and tips on Binance P2P automation, M-Pesa payment verification, and crypto trading in Kenya.',
        url: URL,
        publisher: { '@id': 'https://sparkp2p.com/#organization' },
        blogPost: POSTS.map(p => ({
          '@type': 'BlogPosting',
          headline: p.title,
          description: p.excerpt,
          datePublished: p.date,
          url: 'https://sparkp2p.com' + p.path,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://sparkp2p.com/' },
          { '@type': 'ListItem', position: 2, name: 'Blog', item: URL },
        ],
      },
    ],
  };

  return (
    <ArticleLayout
      seo={{
        title: 'SparkP2P Blog — Binance P2P Automation & M-Pesa Guides for Kenya',
        description: 'Guides and tips on automating Binance P2P trading with M-Pesa in Kenya — payment verification, bot safety, and trading smarter as a merchant.',
        canonical: URL,
        jsonLd,
      }}
      badge="Blog"
      title="The SparkP2P Blog"
      subtitle="Guides and tips on automating Binance P2P trading with M-Pesa in Kenya."
    >
      <div className="blog-list">
        {POSTS.map(p => (
          <Link key={p.slug} to={p.path} className="blog-card">
            <div className="blog-card-meta">
              <span className="blog-card-badge">{p.badge}</span>
              <span className="blog-card-date">{formatPostDate(p.date)} · {p.readMins} min read</span>
            </div>
            <h2 className="blog-card-title">{p.title}</h2>
            <p className="blog-card-excerpt">{p.excerpt}</p>
            <span className="blog-card-link">Read article →</span>
          </Link>
        ))}
      </div>
    </ArticleLayout>
  );
}
