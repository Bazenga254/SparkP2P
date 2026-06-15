import { useEffect } from 'react';

// Per-route SEO head manager for our content/landing pages. The site is a client-rendered SPA,
// so each route shares the static <head> from index.html unless we override it here. Googlebot
// renders JS and reads these updated tags. We set title/description/canonical/OG + optional
// JSON-LD on mount and restore the site defaults on unmount so navigating away is clean.
const DEFAULT_TITLE = 'SparkP2P — Binance P2P Automation Bot for Kenya (M-Pesa)';
const DEFAULT_DESC = 'SparkP2P is an automated Binance P2P trading bot for Kenya. It verifies M-Pesa payments instantly and releases USDT automatically, 24/7 — trade crypto P2P hands-free.';
const DEFAULT_CANONICAL = 'https://sparkp2p.com/';

function setMeta(selector, attr, value) {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement('meta');
    const [, key] = selector.match(/\[(?:name|property)="(.+)"\]/) || [];
    if (selector.includes('property=')) el.setAttribute('property', key);
    else el.setAttribute('name', key);
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}

function setCanonical(url) {
  let el = document.head.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', 'canonical');
    document.head.appendChild(el);
  }
  el.setAttribute('href', url);
}

export function useSeo({ title, description, canonical, jsonLd }) {
  useEffect(() => {
    const url = canonical || DEFAULT_CANONICAL;
    document.title = title || DEFAULT_TITLE;
    setMeta('meta[name="description"]', 'content', description || DEFAULT_DESC);
    setCanonical(url);
    setMeta('meta[property="og:title"]', 'content', title || DEFAULT_TITLE);
    setMeta('meta[property="og:description"]', 'content', description || DEFAULT_DESC);
    setMeta('meta[property="og:url"]', 'content', url);
    setMeta('meta[name="twitter:title"]', 'content', title || DEFAULT_TITLE);
    setMeta('meta[name="twitter:description"]', 'content', description || DEFAULT_DESC);

    let script;
    if (jsonLd) {
      script = document.createElement('script');
      script.type = 'application/ld+json';
      script.setAttribute('data-seo-route', 'true');
      script.textContent = JSON.stringify(jsonLd);
      document.head.appendChild(script);
    }

    return () => {
      document.title = DEFAULT_TITLE;
      setMeta('meta[name="description"]', 'content', DEFAULT_DESC);
      setCanonical(DEFAULT_CANONICAL);
      setMeta('meta[property="og:title"]', 'content', DEFAULT_TITLE);
      setMeta('meta[property="og:description"]', 'content', DEFAULT_DESC);
      setMeta('meta[property="og:url"]', 'content', DEFAULT_CANONICAL);
      if (script && script.parentNode) script.parentNode.removeChild(script);
    };
  }, [title, description, canonical, jsonLd]);
}
