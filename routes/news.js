const express = require('express');
const pool = require('../db/pool');
const { asyncRoute } = require('../middleware/logger');

const router = express.Router();

// GET /news -> últimas noticias de reciclaje, públicas
router.get('/', asyncRoute(async (req, res) => {
  const result = await pool.query(
    'SELECT id, title, summary, link, source, published_at FROM news_articles ORDER BY published_at DESC LIMIT 30'
  );
  res.json(result.rows);
}));

module.exports = router;
