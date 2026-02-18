#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── Default Sources ──────────────────────────────────────────────────────────
const DEFAULT_SOURCES = [
  // ── AI Labs & Research ──
  { name: "OpenAI Blog",            url: "https://openai.com/blog",                                  selector: "h3, h2", category: "ai-labs" },
  { name: "Anthropic News",         url: "https://www.anthropic.com/news",                           selector: "h3, h2", category: "ai-labs" },
  { name: "Google DeepMind",        url: "https://deepmind.google/discover/blog/",                   selector: "h3, h2", category: "ai-labs" },
  { name: "Google AI Blog",         url: "https://blog.google/technology/ai/",                       selector: "h3, h2", category: "ai-labs" },
  { name: "Meta AI Blog",           url: "https://ai.meta.com/blog/",                                selector: "h3, h2", category: "ai-labs" },

  // ── AI & Tech News ──
  { name: "Hacker News",            url: "https://news.ycombinator.com",                             selector: ".titleline > a", category: "ai-news" },
  { name: "TechCrunch AI",          url: "https://techcrunch.com/category/artificial-intelligence/",  selector: "h3, h2", category: "ai-news" },
  { name: "The Verge AI",           url: "https://www.theverge.com/ai-artificial-intelligence",       selector: "h2, h3", category: "ai-news" },
  { name: "Ars Technica AI",        url: "https://arstechnica.com/ai/",                              selector: "h2",     category: "ai-news" },
  { name: "VentureBeat AI",         url: "https://venturebeat.com/category/ai/",                     selector: "h2, h3", category: "ai-news" },

  // ── Startups & YC ──
  { name: "Y Combinator Blog",      url: "https://www.ycombinator.com/blog",                         selector: "h3, h2", category: "startups" },
  { name: "YC Launch",              url: "https://www.ycombinator.com/launches",                     selector: "h3, h2", category: "startups" },
  { name: "TechCrunch Startups",    url: "https://techcrunch.com/category/startups/",                selector: "h3, h2", category: "startups" },
  { name: "Product Hunt",           url: "https://www.producthunt.com",                              selector: "h3, h2", category: "startups" },

  // ── AI Community & Research ──
  { name: "Hugging Face Blog",      url: "https://huggingface.co/blog",                              selector: "h2, h3, article a", category: "ai-community" },
  { name: "MarkTechPost",           url: "https://www.marktechpost.com",                             selector: "h2, h3", category: "ai-community" },
];

// ─── Category Labels ──────────────────────────────────────────────────────────
const CATEGORY_LABELS = {
  "ai-labs":      "🧠 AI Labs & Research",
  "ai-news":      "📰 AI & Tech News",
  "startups":     "🚀 Startups & YC",
  "ai-community": "🤗 AI Community",
};

// ─── Config ───────────────────────────────────────────────────────────────────
const OUTPUT_DIR  = path.join(process.cwd(), "output");
const CONFIG_FILE = path.join(process.cwd(), "sources.json");
const MAX_PER_SOURCE = 8;
const TMPDIR_ENV  = { TMPDIR: "/tmp", XDG_RUNTIME_DIR: "/tmp", ...process.env };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ab(cmd) {
  try {
    const opts = process.env.AGENT_BROWSER_OPTS || "--ignore-https-errors";
    return execSync(`npx agent-browser ${opts} ${cmd}`, {
      env: TMPDIR_ENV, timeout: 45_000, encoding: "utf-8",
    }).replace(/npm notice[^\n]*/g, "").replace(/⚠[^\n]*/g, "").trim();
  } catch (e) {
    return e.stdout?.replace(/npm notice[^\n]*/g, "").trim() || "";
  }
}

function sleep(ms) { execSync(`sleep ${ms / 1000}`); }
function timestamp() { return new Date().toISOString().split("T")[0]; }

function loadSources() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const custom = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      console.log(`📂 Loaded ${custom.length} sources from sources.json`);
      return custom;
    } catch (e) {
      console.log(`⚠ Failed to parse sources.json, using defaults`);
    }
  }
  return DEFAULT_SOURCES;
}

// ─── Core: Fetch Headlines ───────────────────────────────────────────────────
function fetchFromSource(source) {
  const articles = [];

  try {
    ab(`open "${source.url}"`);
    sleep(4000);

    // Try JS eval
    const js = `JSON.stringify(Array.from(document.querySelectorAll('${source.selector}')).slice(0,${MAX_PER_SOURCE}).map(el=>{const link=el.closest('a')||el.querySelector('a')||el.parentElement?.closest('a');return{title:el.innerText.trim().substring(0,200),url:link?link.href:''}}).filter(a=>a.title.length>10))`;

    let result = ab(`eval "${js.replace(/"/g, '\\"')}"`);
    let parsed = [];

    try {
      parsed = JSON.parse(result.replace(/^"|"$/g, ""));
    } catch {
      // Fallback: snapshot
      const snapshot = ab("snapshot -i -c -d 3");
      const lines = snapshot.split("\n").filter(l => l.includes("link") || l.includes("heading"));
      parsed = lines
        .map(l => {
          const titleMatch = l.match(/"([^"]{15,200})"/);
          const urlMatch = l.match(/\/url:\s*(.+)/);
          return titleMatch ? { title: titleMatch[1], url: urlMatch ? urlMatch[1].trim() : "" } : null;
        })
        .filter(Boolean)
        .slice(0, MAX_PER_SOURCE);
    }

    for (const a of parsed) {
      if (a.title && a.title.length > 10) {
        articles.push({
          source: source.name,
          sourceUrl: source.url,
          category: source.category || "uncategorized",
          title: a.title.replace(/[\r\n]+/g, " ").trim().slice(0, 200),
          url: a.url || source.url,
          fetchedAt: new Date().toISOString(),
        });
      }
    }
  } catch {}

  return articles;
}

// ─── Core: Generate Markdown ─────────────────────────────────────────────────
function generateMarkdown(articles, sources) {
  const date = timestamp();
  const uniqueSources = [...new Set(articles.map(a => a.source))];
  const lines = [
    `# 🤖 AI & Startup News — ${date}`,
    "",
    `> Auto-generated by [news-agent](https://github.com/opendots10/news-agent)`,
    `> ${articles.length} articles from ${uniqueSources.length} sources | ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ];

  // Group by category
  const categoryOrder = ["ai-labs", "ai-news", "startups", "ai-community", "uncategorized"];
  for (const cat of categoryOrder) {
    const catArticles = articles.filter(a => a.category === cat);
    if (catArticles.length === 0) continue;

    const label = CATEGORY_LABELS[cat] || cat;
    lines.push(`## ${label}`);
    lines.push("");

    catArticles.forEach((a, i) => {
      const display = a.url && a.url !== a.sourceUrl
        ? `[${a.title}](${a.url})`
        : a.title;
      lines.push(`${i + 1}. **${display}**`);
      lines.push(`   *Source: ${a.source}*`);
      lines.push("");
    });

    lines.push("---");
    lines.push("");
  }

  lines.push("## 📋 All Sources");
  lines.push("");
  sources.forEach(s => lines.push(`- [${s.name}](${s.url})`));
  lines.push("");
  lines.push("---");
  lines.push(`*Generated on ${new Date().toISOString()}*`);

  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
news-agent — AI & Startup News Aggregator

Usage:
  news-agent [options]

Options:
  --fetch          Fetch headlines only (skip summary generation)
  --json           Output results as JSON
  --top=N          Number of top articles (default: all)
  --category=CAT   Filter by category (ai-labs, ai-news, startups, ai-community)
  --sources        Print configured sources and exit
  --init           Generate a sources.json config file from defaults
  --help           Show this help

Examples:
  node index.js                           # Fetch all news
  node index.js --category=ai-labs        # Only AI lab news
  node index.js --top=20 --json           # Top 20 as JSON
  node index.js --init                    # Create sources.json for customization
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const sources = loadSources();

  if (args.includes("--init")) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(sources, null, 2));
    console.log(`✅ Created sources.json with ${sources.length} sources. Edit it to customize.`);
    return;
  }

  if (args.includes("--sources")) {
    console.log("\nConfigured Sources:\n");
    for (const s of sources) {
      console.log(`  [${s.category}] ${s.name} — ${s.url}`);
    }
    return;
  }

  const fetchOnly    = args.includes("--fetch");
  const outputJson   = args.includes("--json");
  const topN         = parseInt(args.find(a => a.startsWith("--top="))?.split("=")[1]) || 0;
  const catFilter    = args.find(a => a.startsWith("--category="))?.split("=")[1] || "";

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("🤖 news-agent — AI & Startup News Aggregator");
  console.log("=============================================");
  console.log(`📡 Scanning ${sources.length} sources...\n`);

  // Fetch from all sources
  let allArticles = [];
  for (const source of sources) {
    if (catFilter && source.category !== catFilter) continue;
    console.log(`  → ${source.name}`);
    const articles = fetchFromSource(source);
    allArticles.push(...articles);
    console.log(`    ✓ ${articles.length} articles`);
  }

  // Deduplicate
  const seen = new Set();
  let unique = allArticles.filter(a => {
    const key = a.title.toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (topN > 0) unique = unique.slice(0, topN);

  console.log(`\n📊 Total: ${allArticles.length} raw, ${unique.length} unique articles\n`);

  // Save
  const date = timestamp();
  const jsonFile = path.join(OUTPUT_DIR, `ai-news-${date}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(unique, null, 2));
  console.log(`📦 JSON: ${jsonFile}`);

  if (!fetchOnly) {
    const md = generateMarkdown(unique, sources);
    const mdFile = path.join(OUTPUT_DIR, `ai-news-${date}.md`);
    fs.writeFileSync(mdFile, md);
    console.log(`📝 Markdown: ${mdFile}`);

    if (outputJson) {
      console.log(JSON.stringify(unique, null, 2));
    } else {
      console.log("\n" + md);
    }
  }

  ab("close");
  console.log("\n✅ Done!");
}

run().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
