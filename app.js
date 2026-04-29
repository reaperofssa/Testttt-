// server.js
const express = require("express");
const axios = require("axios");
const puppeteer = require("puppeteer");
const stringSimilarity = require("string-similarity");
const app = express();
const PORT = 7860;

// ─── Browser Pool ────────────────────────────────────────────────────────────
// Reuse a single shared browser instead of launching one per request.
// Each request still gets its own page (tab), so they're isolated.

let sharedBrowser = null;
let browserLock = false;

async function getBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;

  // Prevent concurrent launches
  while (browserLock) await new Promise(r => setTimeout(r, 50));
  browserLock = true;

  try {
    if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;

    sharedBrowser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--mute-audio",
        "--no-first-run",
      ],
    });

    // Auto-restart browser if it crashes
    sharedBrowser.on("disconnected", () => {
      sharedBrowser = null;
    });

    return sharedBrowser;
  } finally {
    browserLock = false;
  }
}

// Helper: open a page, run fn(page), close page — all error-safe
async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // Block images, fonts, media to speed up page loads
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "media", "font", "stylesheet"].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── AnimePahe API helper (no browser needed) ────────────────────────────────
// AnimePahe exposes a public API that we can call directly with axios.
// This is MUCH faster than loading pages with Puppeteer.

async function paheApi(params) {
  const url = "https://animepahe.pw/api";
  const res = await axios.get(url, {
    params,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Referer: "https://animepahe.pw/",
      Cookie: "__ddg1_=; __ddg2_=",       // bypass basic bot checks
    },
    timeout: 10000,
  });
  return res.data;
}

// ─── GET /search ─────────────────────────────────────────────────────────────
// Navigates to animepahe.pw first (to get valid cookies/session),
// then calls the search API via fetch inside the browser context
// so all headers/cookies are set correctly — avoids 403 from ddos-guard.

app.get("/search", async (req, res) => {
  const q = (req.query.q || "Naruto").trim();

  try {
    const data = await withPage(async (page) => {
      // Visit the homepage first to establish cookies & bypass ddos-guard
      await page.goto("https://animepahe.pw", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      // Now call the search API from within the browser context —
      // it will carry the correct cookies, Referer, and X-Requested-With header
      const result = await page.evaluate(async (query) => {
        const url = `https://animepahe.pw/api?m=search&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
          headers: {
            Accept: "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        if (!res.ok) throw new Error(`Search API returned ${res.status}`);
        return await res.json();
      }, q);

      return result;
    });

    if (!data || !data.data) return res.json([]);

    const results = data.data.map((anime) => ({
      id: anime.id,
      title: anime.title,
      session: anime.session,
      link: `https://animepahe.pw/anime/${anime.session}`,
      poster: anime.poster,
      type: anime.type,
      episodes: anime.episodes,
      status: anime.status,
      season: anime.season,
      year: anime.year,
      score: anime.score,
      similarity: stringSimilarity.compareTwoStrings(
        anime.title.toLowerCase(),
        q.toLowerCase()
      ),
    }));

    results.sort((a, b) => b.similarity - a.similarity);
    return res.json(results.slice(0, 10));
  } catch (err) {
    console.error("Search error:", err.message);
    return res.status(500).json({ error: "Failed to fetch search results." });
  }
});

// ─── GET /info ────────────────────────────────────────────────────────────────
// Scrapes the anime detail page. Uses shared browser + resource blocking.

app.get("/info", async (req, res) => {
  const url = req.query.url;

  if (!url || !url.startsWith("https://animepahe.pw/anime/")) {
    return res.status(400).json({ error: "Invalid or missing AnimePahe URL." });
  }

  try {
    const data = await withPage(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForSelector("section.main", { timeout: 10000 });

      const animeId = await page.evaluate(() => {
        const meta = document.querySelector('meta[property="og:url"]');
        return meta ? meta.content.split("/").pop() : null;
      });

      if (!animeId) throw new Error("Failed to extract anime ID");

      const scraped = await page.evaluate(() => {
        const getText = (sel) => document.querySelector(sel)?.textContent.trim() ?? null;
        const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) ?? null;

        const info = {};
        document.querySelectorAll(".anime-info p").forEach((p) => {
          const strong = p.querySelector("strong");
          if (!strong) return;
          const key = strong.textContent.replace(":", "").trim().toLowerCase();
          info[key] = p.textContent.replace(strong.textContent, "").trim();
        });

        return {
          title: getText("h1 span"),
          japaneseTitle: getText("h2.japanese"),
          synopsis: getText(".anime-synopsis"),
          poster: getAttr(".anime-poster img", "data-src"),
          cover: getAttr(".anime-cover", "data-src"),
          info,
          genres: [...document.querySelectorAll(".anime-genre li a")].map((a) =>
            a.textContent.trim()
          ),
          externalLinks: [...document.querySelectorAll(".external-links a")].map((a) => ({
            label: a.textContent.trim(),
            url: a.href,
          })),
        };
      });

      return { ...scraped, animeId };
    });

    // Fetch episode count via API (no browser needed)
    let totalEpisodes = 0;
    for (let p = 1; p <= 50; p++) {
      const json = await paheApi({ m: "release", id: data.animeId, page: p }).catch(() => null);
      if (!json?.data?.length) break;
      totalEpisodes += json.data.length;
      if (json.last_page && p >= json.last_page) break;
    }

    return res.json({ ...data, totalEpisodes });
  } catch (err) {
    console.error("Anime info error:", err.message);
    return res.status(500).json({ error: "Failed to fetch anime info." });
  }
});

// ─── GET /api/list ────────────────────────────────────────────────────────────
// Returns a paginated list of episodes for an anime.
// Query params: id (anime UUID), page (default 1), sort (episode_asc|episode_desc)

app.get("/api/list", async (req, res) => {
  const { id, page = 1, sort = "episode_asc" } = req.query;

  if (!id) {
    return res.status(400).json({ error: "'id' query parameter is required." });
  }

  try {
    const data = await paheApi({ m: "release", id, page, sort });

    if (!data) {
      return res.status(404).json({ error: "No data returned for this anime ID." });
    }

    // Normalize episodes
    const episodes = (data.data || []).map((ep) => ({
      episode: ep.episode,
      session: ep.session,
      snapshot: ep.snapshot?.replace(/\\\//g, "/") ?? null,
      duration: ep.duration,
      created_at: ep.created_at,
    }));

    return res.json({
      animeId: id,
      page: data.current_page ?? Number(page),
      lastPage: data.last_page ?? 1,
      total: data.total ?? episodes.length,
      perPage: data.per_page ?? episodes.length,
      episodes,
    });
  } catch (err) {
    console.error("Episode list error:", err.message);
    return res.status(500).json({ error: "Failed to fetch episode list." });
  }
});

// ─── GET /api/episode ─────────────────────────────────────────────────────────
// Given an anime ID + episode session, returns streaming/download links.
// Query params: id (anime UUID), session (episode session string)

app.get("/api/episode", async (req, res) => {
  const { id: animeId, session } = req.query;

  if (!animeId || !session) {
    return res
      .status(400)
      .json({ error: "'id' and 'session' query parameters are required." });
  }

  const playUrl = `https://animepahe.pw/play/${animeId}/${session}`;

  try {
    const result = await withPage(async (page) => {
      await page.goto(playUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForSelector("#resolutionMenu", { timeout: 10000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));

      const links = await page.evaluate(() => {
        // ── Stream links ──────────────────────────────────────────────────────
        // Keyed by audio language, each entry is an array of source objects
        // e.g. { jpn: [{fansub,resolution,av1,url}, ...], eng: [...], kor: [...] }
        const stream = {};

        document.querySelectorAll("#resolutionMenu button[data-src]").forEach((btn) => {
          const fansub     = btn.getAttribute("data-fansub")     || "unknown";
          const resolution = btn.getAttribute("data-resolution") || "?";
          const audio      = btn.getAttribute("data-audio")      || "unknown";
          const av1        = btn.getAttribute("data-av1") === "1";
          const url        = btn.getAttribute("data-src");

          if (!url) return;
          if (!stream[audio]) stream[audio] = [];
          stream[audio].push({ fansub, resolution: resolution + "p", av1, url });
        });

        // ── Download links ────────────────────────────────────────────────────
        // Keyed by audio language, each entry is an array of download objects
        // e.g. { jpn: [{fansub,resolution,size,url}, ...], eng: [...] }
        // Text format on page: "FLE · 720p (108MB)" with optional badge "eng"/"kor"
        const download = {};

        document.querySelectorAll("#pickDownload a").forEach((a) => {
          const href = a.href;
          if (!href) return;

          // Clone so we can read text without badge noise
          const clone = a.cloneNode(true);

          // Pull out badge texts (audio language indicators like "eng", "kor")
          const badges = [...clone.querySelectorAll(".badge-warning")].map(b =>
            b.textContent.trim().toLowerCase()
          );
          // Remove badges from clone so they don't pollute the main text parse
          clone.querySelectorAll(".badge").forEach(b => b.remove());

          const rawText = clone.textContent.trim(); // e.g. "FLE · 720p (108MB)"

          // Parse fansub (text before ·), resolution (e.g. 720p), size (e.g. 108MB)
          const fansubMatch    = rawText.match(/^([^\s·]+)/);
          const resolutionMatch = rawText.match(/(\d+p)/i);
          const sizeMatch      = rawText.match(/\(([^)]+)\)/);

          const fansub     = fansubMatch     ? fansubMatch[1]     : "unknown";
          const resolution = resolutionMatch ? resolutionMatch[1] : "?";
          const size       = sizeMatch       ? sizeMatch[1]       : null;

          // Determine audio language — badge takes priority, fallback to "jpn" (sub)
          const audio = badges.length > 0 ? badges[0] : "jpn";

          if (!download[audio]) download[audio] = [];
          download[audio].push({ fansub, resolution, size, url: href });
        });

        return { stream, download };
      });

      return { links, playUrl };
    });

    return res.json({ animeId, session, ...result });
  } catch (err) {
    console.error("Episode error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGINT", async () => {
  if (sharedBrowser) await sharedBrowser.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  if (sharedBrowser) await sharedBrowser.close();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  // Pre-warm the browser so the first request isn't slow
  getBrowser().then(() => console.log("Browser ready.")).catch(console.error);
});
