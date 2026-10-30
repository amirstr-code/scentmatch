const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const APRIL_BASE = 'https://www.april.co.il';
const CACHE_TTL = 30 * 60 * 1000;
let cache = { perfumes: null, ts: 0 };

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
};

async function scrapePage(url, gender) {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const html = await resp.text();
  const $ = cheerio.load(html);
  const products = [];
  const seen = new Set();

  // Build price map from GA4 view_item_list JSON embedded in page
  const priceMap = {};
  const itemsMatch = html.match(/"items":\s*\[([\s\S]*?)\]\s*\n\s*\}/);
  if (itemsMatch) {
    try {
      JSON.parse('[' + itemsMatch[1] + ']').forEach(item => {
        priceMap[item.item_id] = item.price;
      });
    } catch (_) { }
  }

  // Find all product images, then traverse up to the card container
  $('img[data-src*="Uploads"]').each((_, imgEl) => {
    const img = $(imgEl);
    const dataSrc = img.attr('data-src') || '';
    const barcodeMatch = dataSrc.match(/(\d{10,})-\.webp/);
    if (!barcodeMatch) return;

    const barcode = barcodeMatch[1];
    if (seen.has(barcode)) return;
    seen.add(barcode);

    // Go up to card container (look for parent that has both image and card-body)
    const card = img.closest('.col, .card, li, [class*="col-"]').first();
    const container = card.length ? card : img.closest('div').parent();

    const brand = container.find('.firm-product-list span, .firm-product-list').first().text().trim();
    const hebrewName = container.find('.card-title, h2, h3').first().text().trim();
    const engTitle = img.attr('alt') || img.attr('title') || '';

    // Get product URL from the image anchor or card-body anchor
    const href = container.find('a[href*="perfume"], a[href*="cologne"], a[href*="parfum"]').first().attr('href') || '';

    // Match price by barcode suffix vs item_id
    let price = null;
    const suffix = barcode.slice(3);
    for (const [id, p] of Object.entries(priceMap)) {
      if (suffix === id.replace('vir_', '')) { price = p; break; }
    }

    const name = hebrewName || engTitle;
    if (!name) return;

    products.push({
      id: barcode,
      name,
      nameEn: engTitle,
      brand: brand || extractBrandFromName(engTitle),
      price,
      gender,
      imageUrl: `${APRIL_BASE}/Media/Uploads/${barcode}-.webp`,
      productUrl: href ? `${APRIL_BASE}/${href}` : `${APRIL_BASE}/${gender === 'F' ? 'women' : 'men'}-perfume`,
    });
  });

  return products;
}

// Fallback: extract brand as last capitalized word(s) from English name
function extractBrandFromName(nameEn) {
  if (!nameEn) return '';
  const knownBrands = [
    'Carven','Hermès','Guerlain','Versace','Zadig & Voltaire','Narciso Rodriguez',
    'Carolina Herrera','Jean Paul Gaultier','Maison Matine','Rabanne','Spring',
    'Dolce & Gabbana','Michael Kors','Giorgio Armani','Abercrombie & Fitch',
    'Hugo Boss','Paco Rabanne','Issey Miyake','Dior','Chanel','Yves Saint Laurent',
    'YSL','Burberry','Calvin Klein','Marc Jacobs','Tom Ford','Givenchy',
    'Lancôme','Nina Ricci','Hugo','Boss','Bvlgari','Davidoff',
  ];
  for (const brand of knownBrands) {
    if (nameEn.endsWith(brand)) return brand;
  }
  // Last word as fallback
  const words = nameEn.trim().split(' ');
  return words[words.length - 1] || '';
}

async function fetchPerfumes() {
  if (cache.perfumes && Date.now() - cache.ts < CACHE_TTL) return cache.perfumes;

  console.log('[ScentMatch] Fetching from April...');
  const [women, men] = await Promise.all([
    scrapePage(`${APRIL_BASE}/women-perfume`, 'F'),
    scrapePage(`${APRIL_BASE}/men-perfume`, 'M'),
  ]);

  const all = [...women, ...men];
  console.log(`[ScentMatch] ${women.length} women + ${men.length} men = ${all.length} total`);
  cache = { perfumes: all, ts: Date.now() };
  return all;
}

app.get('/api/perfumes', async (req, res) => {
  try {
    res.json({ ok: true, perfumes: await fetchPerfumes() });
  } catch (err) {
    console.error('[ScentMatch]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  cache = { perfumes: null, ts: 0 };
  try {
    res.json({ ok: true, count: (await fetchPerfumes()).length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3033;
app.listen(PORT, () => console.log(`[ScentMatch] http://localhost:${PORT}`));
