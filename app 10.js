// server.js
const express = require("express");
const axios = require("axios");
const puppeteer = require("puppeteer");
const stringSimilarity = require("string-similarity");
const app = express();
const PORT = 7860;

app.get("/search", async (req, res) => {
  const animeQuery = req.query.q || "Naruto";

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://animepahe.pw/anime', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tab-content .tab-pane');
    await autoScroll(page);

    const results = await page.evaluate(() => {
      const allAnime = [];
      const panes = document.querySelectorAll('.tab-content .tab-pane');
      panes.forEach(pane => {
        const items = pane.querySelectorAll('.col-12.col-md-6 a');
        items.forEach(a => {
          const title = a.getAttribute('title');
          const link = a.getAttribute('href');
          if (title && link) allAnime.push({ title, link });
        });
      });
      return allAnime;
    });

    // Use string similarity to find close matches
    const matches = results.map(anime => {
      const similarity = stringSimilarity.compareTwoStrings(anime.title.toLowerCase(), animeQuery.toLowerCase());
      return { ...anime, similarity };
    });

    // Sort by similarity
    matches.sort((a, b) => b.similarity - a.similarity);

    await browser.close();

    // Return top 10 matches
    return res.json(matches.slice(0, 10));
  } catch (err) {
    await browser.close();
    console.error("Puppeteer search error:", err.message);
    return res.status(500).json({ error: "Failed to fetch search results." });
  }
});

// Helper function for scrolling
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

app.get("/info", async (req, res) => {
  const url = req.query.url;

  if (!url || !url.startsWith("https://animepahe.pw/anime/")) {
    return res.status(400).json({ error: "Invalid or missing AnimePahe URL." });
  }

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section.main");

    // Extract anime ID
    const animeId = await page.evaluate(() => {
      const meta = document.querySelector('meta[property="og:url"]');
      return meta ? meta.content.split("/").pop() : null;
    });

    if (!animeId) throw new Error("Failed to extract anime ID");

    // Scrape anime data
    const data = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : null;
      };

      const getAttr = (selector, attr) => {
        const el = document.querySelector(selector);
        return el ? el.getAttribute(attr) : null;
      };

      const poster = getAttr(".anime-poster img", "data-src");
      const cover = getAttr(".anime-cover", "data-src");
      const title = getText("h1 span");
      const japaneseTitle = getText("h2.japanese");
      const synopsis = getText(".anime-synopsis");

      const info = {};
      document.querySelectorAll(".anime-info p").forEach(p => {
        const strong = p.querySelector("strong");
        if (!strong) return;
        const key = strong.textContent.replace(":", "").trim().toLowerCase();
        const value = p.textContent.replace(strong.textContent, "").trim();
        info[key] = value;
      });

      const genres = Array.from(document.querySelectorAll(".anime-genre li a")).map(a => a.textContent.trim());
      const externalLinks = Array.from(document.querySelectorAll(".external-links a")).map(a => ({
        label: a.textContent.trim(),
        url: a.href
      }));

      return {
        title,
        japaneseTitle,
        synopsis,
        poster,
        cover,
        info,
        genres,
        externalLinks
      };
    });

    // Fetch total number of episodes using fetch inside browser context
    const totalEpisodes = await page.evaluate(async (animeId) => {
      let total = 0;
      for (let pageNum = 1; pageNum <= 50; pageNum++) {
        const res = await fetch(`https://animepahe.pw/api?m=release&id=${animeId}&page=${pageNum}`);
        if (!res.ok) break;
        const json = await res.json();
        if (!json || !json.data || json.data.length === 0) break;
        total += json.data.length;
      }
      return total;
    }, animeId);

    await browser.close();

    res.json({
      ...data,
      animeId,
      totalEpisodes
    });

  } catch (err) {
    await browser.close();
    console.error("Anime info error:", err.message);
    res.status(500).json({ error: "Failed to fetch anime info." });
  }
});

app.get('/api/episode', async (req, res) => {
  const animeId = req.query.id;
  const episodeQuery = parseInt(req.query.episode);

  if (!animeId || isNaN(episodeQuery)) {
    return res.status(400).json({ error: 'id and episode query parameters are required' });
  }

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Go directly to the anime page using the ID
    await page.goto(`https://animepahe.pw/anime/${animeId}`, { waitUntil: 'domcontentloaded' });

    // Verify the anime page loaded correctly
    const pageTitle = await page.title();
    if (pageTitle.includes('404') || pageTitle.includes('Not Found')) {
      await browser.close();
      return res.status(404).json({ error: 'Anime not found' });
    }

    // Search for episode
    let found = null;
    for (let pageNum = 1; pageNum <= 50; pageNum++) {
      const data = await page.evaluate(async (animeId, pageNum) => {
        const apiUrl = `https://animepahe.pw/api?m=release&id=${animeId}&page=${pageNum}&sort=episode_asc`;
        const res = await fetch(apiUrl);
        if (!res.ok) return null;
        return await res.json();
      }, animeId, pageNum);

      if (!data || !data.data) continue;

      const match = data.data.find(ep => ep.episode == episodeQuery || ep.number == episodeQuery);
      if (match) {
        found = {
          episode: match.episode,
          snapshot: match.snapshot.replace(/\\\//g, '/'),
          session: match.session
        };
        break;
      }
    }

    if (!found) {
      await browser.close();
      return res.status(404).json({ error: `Episode ${episodeQuery} not found.` });
    }

    const playUrl = `https://animepahe.pw/play/${animeId}/${found.session}`;

    // Go to play page
    const playPage = await browser.newPage();
    await playPage.goto(playUrl, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 5000));

    // Extract and organize links by quality and audio type
    const links = await playPage.evaluate(() => {
      const result = {
        sub: {},
        dub: {}
      };
      
      // Extract streaming links (kwik.si)
      const streamButtons = document.querySelectorAll('#resolutionMenu button[data-src]');
      streamButtons.forEach(button => {
        const quality = button.getAttribute('data-resolution') + 'p';
        const audio = button.getAttribute('data-audio');
        const url = button.getAttribute('data-src');
        
        if (audio === 'jpn') {
          result.sub[quality] = url;
        } else if (audio === 'eng') {
          result.dub[quality] = url;
        }
      });
      
      // Extract download links (pahe.win)
      const downloadLinks = document.querySelectorAll('#pickDownload a[href*="pahe.win"]');
      downloadLinks.forEach(a => {
        const text = a.innerText.trim().toLowerCase();
        const href = a.href;
        const isDub = text.includes('eng');
        
        if (text.includes('360')) {
          if (isDub) result.dub['360p_download'] = href;
          else result.sub['360p_download'] = href;
        } 
        else if (text.includes('480')) {
          if (isDub) result.dub['480p_download'] = href;
          else result.sub['480p_download'] = href;
        }
        else if (text.includes('720')) {
          if (isDub) result.dub['720p_download'] = href;
          else result.sub['720p_download'] = href;
        }
        else if (text.includes('1080')) {
          if (isDub) result.dub['1080p_download'] = href;
          else result.sub['1080p_download'] = href;
        }
      });
      
      return result;
    });

    await playPage.close();
    await browser.close();

    return res.json({
      animeId,
      episode: found.episode,
      snapshot: found.snapshot, // Using the original snapshot URL directly
      playUrl,
      links
    });

  } catch (err) {
    await browser.close();
    return res.status(500).json({ error: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});