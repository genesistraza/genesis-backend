const cron = require('node-cron');
const Parser = require('rss-parser');
const pool = require('../db/pool');

const parser = new Parser();

const FEEDS = [
  'https://news.google.com/rss/search?q=reciclaje+Colombia&hl=es-419&gl=CO&ceid=CO:es-419',
  'https://news.google.com/rss/search?q=econom%C3%ADa+circular&hl=es-419&gl=CO&ceid=CO:es-419'
];

async function fetchNews() {
  for (const feedUrl of FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items.slice(0, 20)) {
        await pool.query(
          `INSERT INTO news_articles (title, summary, link, source, published_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (link) DO NOTHING`,
          [
            item.title,
            (item.contentSnippet || '').slice(0, 400),
            item.link,
            item.source || (feed.title || 'Google News'),
            item.isoDate ? new Date(item.isoDate) : new Date()
          ]
        );
      }
    } catch (err) {
      console.error('No se pudo leer el feed de noticias:', feedUrl, err.message);
    }
  }

  // Conserva solo las 60 más recientes
  await pool.query(`
    DELETE FROM news_articles WHERE id NOT IN (
      SELECT id FROM news_articles ORDER BY published_at DESC LIMIT 60
    )
  `);
}

function startNewsFetcher() {
  fetchNews(); // corre una vez al iniciar el servidor
  cron.schedule('0 */6 * * *', fetchNews); // y luego cada 6 horas
}

module.exports = startNewsFetcher;
