#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────
const NEWS_SOURCES = [
  { name: "Hacker News",       url: "https://news.ycombinator.com",         selector: ".titleline > a" },
  { name: "BBC News",          url: "https://www.bbc.com/news",             selector: "h3" },
  { name: "Reuters",           url: "https://www.reuters.com",              selector: "h3" },
  { name: "TechCrunch",        url: "https://techcrunch.com",               selector: "h3" },
  { name: "The Verge",         url: "https://www.theverge.com",             selector: "h2" },
  { name: "CNN",               url: "https://edition.cnn.com",              selector: "h3" },
  { name: "Al Jazeera",        url: "https://www.aljazeera.com",            selector: "h3" },
  { name: "Google News",       url: "https://news.google.com/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB", selector: "h4, h3" },
];

const OUTPUT_DIR = path.join(process.cwd(), "output");
const AB_OPTS = process.env.AGENT_BROWSER_OPTS || "--ignore-https-errors";
const TMPDIR_ENV = { TMPDIR: "/tmp", XDG_RUNTIME_DIR: "/tmp", ...process.env };
const MAX_ARTICLES_PER_SOURCE = 5;
const TOP_N = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ab(cmd) {
  try {
    const full = `npx agent-browser ${AB_OPTS} ${cmd}`;
    return execSync(full, { env: TMPDIR_ENV, timeout: 30_000, encoding: "utf-8" }).trim();
  } catch (e) {
    return e.stdout?.trim() || "";
  }
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function timestamp() {
  return new Date().toISOString().split("T")[0];
}

function sanitize(text) {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// ─── Core: Fetch Headlines ───────────────────────────────────────────────────
function fetchHeadlines() {
  console.log("\n📰 Fetching headlines from", NEWS_SOURCES.length, "sources...\n");

  const allArticles = [];

  for (const source of NEWS_SOURCES) {
    console.log(`  → ${source.name} (${source.url})`);

    try {
      ab(`open "${source.url}"`);
      sleep(3000);

      // Get snapshot and extract headlines via JS
      const js = `
        JSON.stringify(
          Array.from(document.querySelectorAll('${source.selector}'))
            .slice(0, ${MAX_ARTICLES_PER_SOURCE})
            .map(el => {
              const link = el.closest('a') || el.querySelector('a') || el.parentElement?.closest('a');
              return {
                title: el.innerText.trim().substring(0, 200),
                url: link ? link.href : '',
              };
            })
            .filter(a => a.title.length > 10)
        )
      `.replace(/\n/g, " ");

      const result = ab(`eval "${js.replace(/"/g, '\\"')}"`);

      try {
        const articles = JSON.parse(result.replace(/^"|"$/g, ""));
        for (const article of articles) {
          if (article.title) {
            allArticles.push({
              source: source.name,
              sourceUrl: source.url,
              title: sanitize(article.title),
              url: article.url || source.url,
              fetchedAt: new Date().toISOString(),
            });
          }
        }
        console.log(`    ✓ Found ${articles.length} headlines`);
      } catch {
        // Fallback: use snapshot
        const snapshot = ab("snapshot -i -c -d 3");
        const lines = snapshot.split("\n").filter(l => l.includes("link") || l.includes("heading"));
        const headlines = lines
          .map(l => l.replace(/.*"([^"]+)".*/, "$1"))
          .filter(t => t.length > 15 && t.length < 200)
          .slice(0, MAX_ARTICLES_PER_SOURCE);

        for (const title of headlines) {
          allArticles.push({
            source: source.name,
            sourceUrl: source.url,
            title: sanitize(title),
            url: source.url,
            fetchedAt: new Date().toISOString(),
          });
        }
        console.log(`    ✓ Found ${headlines.length} headlines (snapshot fallback)`);
      }
    } catch (err) {
      console.log(`    ✗ Failed: ${err.message?.slice(0, 80)}`);
    }
  }

  return allArticles;
}

// ─── Core: Extract Article Content ───────────────────────────────────────────
function extractArticle(url) {
  try {
    ab(`open "${url}"`);
    sleep(2000);

    const js = `
      (function() {
        const article = document.querySelector('article') || document.querySelector('[role="main"]') || document.body;
        const paras = Array.from(article.querySelectorAll('p')).map(p => p.innerText.trim()).filter(t => t.length > 30);
        return JSON.stringify({
          title: document.title,
          text: paras.slice(0, 10).join('\\n\\n'),
          url: window.location.href,
        });
      })()
    `.replace(/\n/g, " ");

    const result = ab(`eval "${js.replace(/"/g, '\\"')}"`);
    return JSON.parse(result.replace(/^"|"$/g, ""));
  } catch {
    return null;
  }
}

// ─── Core: Generate Summary ──────────────────────────────────────────────────
function generateSummary(articles) {
  const date = timestamp();
  const lines = [];

  lines.push(`# 📰 Top ${articles.length} News Stories — ${date}`);
  lines.push("");
  lines.push(`> Auto-generated by [news-agent](https://github.com/opendots10/news-agent) using agent-browser`);
  lines.push(`> Fetched at: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  articles.forEach((article, i) => {
    lines.push(`## ${i + 1}. ${article.title}`);
    lines.push("");
    if (article.content) {
      // Truncate to ~3 sentences for summary
      const sentences = article.content.split(/\.\s+/).slice(0, 3);
      lines.push(sentences.join(". ") + ".");
      lines.push("");
    }
    lines.push(`**Source:** [${article.source}](${article.url})`);
    lines.push("");
    lines.push("---");
    lines.push("");
  });

  lines.push("## Sources");
  lines.push("");
  const sources = [...new Set(articles.map(a => a.source))];
  sources.forEach(s => {
    const a = articles.find(x => x.source === s);
    lines.push(`- [${s}](${a?.sourceUrl || a?.url || "#"})`);
  });
  lines.push("");
  lines.push(`---`);
  lines.push(`*Generated by news-agent on ${new Date().toISOString()}*`);

  return lines.join("\n");
}

// ─── Core: Full Pipeline ─────────────────────────────────────────────────────
async function run() {
  const args = process.argv.slice(2);
  const fetchOnly = args.includes("--fetch");
  const summaryOnly = args.includes("--summary");
  const withContent = args.includes("--full");
  const outputJson = args.includes("--json");
  const count = parseInt(args.find(a => a.startsWith("--top="))?.split("=")[1]) || TOP_N;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("🤖 news-agent — AI-powered news aggregator");
  console.log("=========================================\n");

  // Step 1: Fetch headlines
  let articles;
  const cacheFile = path.join(OUTPUT_DIR, `headlines-${timestamp()}.json`);

  if (summaryOnly && fs.existsSync(cacheFile)) {
    console.log("📂 Loading cached headlines...");
    articles = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
  } else {
    articles = fetchHeadlines();
    fs.writeFileSync(cacheFile, JSON.stringify(articles, null, 2));
    console.log(`\n💾 Saved ${articles.length} headlines to ${cacheFile}`);
  }

  if (fetchOnly) {
    if (outputJson) {
      console.log(JSON.stringify(articles, null, 2));
    }
    ab("close");
    return;
  }

  // Step 2: Deduplicate and pick top N
  const seen = new Set();
  const topArticles = [];
  for (const article of articles) {
    const key = article.title.toLowerCase().slice(0, 50);
    if (!seen.has(key)) {
      seen.add(key);
      topArticles.push(article);
    }
    if (topArticles.length >= count) break;
  }

  console.log(`\n📊 Selected top ${topArticles.length} unique articles`);

  // Step 3: Optionally extract full content
  if (withContent) {
    console.log("\n📖 Extracting full article content...\n");
    for (let i = 0; i < topArticles.length; i++) {
      const article = topArticles[i];
      if (article.url && article.url !== article.sourceUrl) {
        console.log(`  → [${i + 1}/${topArticles.length}] ${article.title.slice(0, 60)}...`);
        const content = extractArticle(article.url);
        if (content?.text) {
          article.content = content.text;
          console.log(`    ✓ Extracted ${content.text.length} chars`);
        } else {
          console.log(`    ✗ Could not extract content`);
        }
      }
    }
  }

  // Step 4: Generate summary
  const summary = generateSummary(topArticles);
  const summaryFile = path.join(OUTPUT_DIR, `news-${timestamp()}.md`);
  fs.writeFileSync(summaryFile, summary);
  console.log(`\n📝 Summary saved to ${summaryFile}`);

  // Also save JSON
  const jsonFile = path.join(OUTPUT_DIR, `news-${timestamp()}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(topArticles, null, 2));
  console.log(`📦 JSON saved to ${jsonFile}`);

  if (outputJson) {
    console.log("\n" + JSON.stringify(topArticles, null, 2));
  } else {
    console.log("\n" + summary);
  }

  // Cleanup
  ab("close");
  console.log("\n✅ Done!");
}

run().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
