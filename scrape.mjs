/**
 * ================================================================
 *  ALL CODES IN ALL GAMES — Scraper  (v2)
 * ================================================================
 *
 *  Laeuft in GitHub Actions (gratis), NICHT im Roblox-Game.
 *  Baut statische JSON-Dateien, die dein Game dann abruft:
 *
 *    public/index.json              -> alle Spielnamen + Slugs (klein)
 *    public/games/<slug>.json       -> Codes fuer ein Spiel
 *
 *  NEU in v2:
 *   - Seitenblaettern korrigiert: /game-codes/2, /game-codes/3 ...
 *     (vorher ?page=2 — das ignoriert die Seite, daher nur 107 Spiele)
 *   - Seitenzahlen und Kategorien werden nicht mehr als Spiel gewertet
 *   - extra-games.txt: eigene Slugs nachtragen, die nirgends verlinkt sind
 *   - mehr Spiele pro Lauf, damit alles in einem Durchgang reinkommt
 *
 *  Die Slug-Liste waechst mit jedem Lauf und schrumpft nie —
 *  einmal gefundene Spiele bleiben im Repo.
 *
 *  Start:  node scrape.mjs
 * ================================================================
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_BASE = "https://robloxden.com";
const INDEX_PATH = "/game-codes";
const OUT_DIR = "public";
const GAMES_DIR = path.join(OUT_DIR, "games");
const EXTRA_FILE = "extra-games.txt";

// Trag hier deine echte Mail ein — gehoert bei Scrapern zum guten Ton.
const USER_AGENT =
  "AllCodesInAllGames/1.0 (Roblox experience; contact: DEINE-MAIL@example.com)";

const DELAY_MS = 350;          // Pause zwischen Abrufen — nicht kleiner machen
const MAX_PER_RUN = 1500;      // wie viele Spiele pro Lauf aufgefrischt werden
const STALE_HOURS = 20;        // aelter als das = neu holen
const MAX_INDEX_PAGES = 80;    // Sicherheitsnetz gegen Endlosschleifen
const EMPTY_PAGES_STOP = 2;    // nach so vielen leeren Seiten ist Schluss

const ACTIVE_STATUS = new Set(["active", "check", "new", "working", "valid"]);

// Pfade unter /game-codes/, die keine Spiele sind
const NOT_A_GAME = new Set([
  "genres",
  "tags",
  "search",
  "page",
  "new",
  "popular",
  "all",
]);

/* ---------------------------------------------------------------- Textkram */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromSlug(slug) {
  return slug
    .split("-")
    .map((w) => (w.length <= 2 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function cleanReward(raw) {
  if (!raw) return "";
  let t = stripTags(raw);
  const bold = t.match(/\*\*(.+?)\*\*/);
  if (bold) t = bold[1];
  t = t
    .replace(/^this code credits your account with\s*/i, "")
    .replace(/^you (?:will )?(?:get|receive)\s*/i, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (!t || t === "-" || t === "\u2014" || /^unknown$/i.test(t)) return "";
  return t.slice(0, 70);
}

function looksLikeCode(s) {
  return (
    typeof s === "string" &&
    s.length >= 2 &&
    s.length <= 40 &&
    /^[A-Za-z0-9!_-]+$/.test(s) &&
    /[A-Za-z0-9]/.test(s)
  );
}

/** Ist das ein echter Spiel-Slug oder eine Seitenzahl / Kategorie? */
function isGameSlug(slug) {
  if (!slug || slug.length < 2) return false;
  if (/^\d+$/.test(slug)) return false; // /game-codes/2 = Seitenzahl
  if (NOT_A_GAME.has(slug)) return false;
  return true;
}

/* ------------------------------------------------------------- Code-Parser */

function extractCodes(html) {
  const found = [];
  const seen = new Set();

  const push = (code, reward, status) => {
    if (!looksLikeCode(code)) return;
    const key = code.toLowerCase();
    if (seen.has(key)) return;
    const st = String(status || "").toLowerCase().trim();
    if (st && !ACTIVE_STATUS.has(st)) return; // abgelaufene raus
    seen.add(key);
    found.push({ code, reward: cleanReward(reward) });
  };

  const nextData = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (nextData) {
    try {
      const walk = (node, depth) => {
        if (!node || depth > 14) return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item, depth + 1);
          return;
        }
        if (typeof node !== "object") return;

        const code = node.code ?? node.Code ?? node.codeText;
        if (looksLikeCode(code)) {
          push(
            code,
            node.description ?? node.reward ?? node.Description ?? "",
            node.status ?? node.state ?? node.Status ?? ""
          );
        }
        for (const key of Object.keys(node)) walk(node[key], depth + 1);
      };
      walk(JSON.parse(nextData[1]), 0);
    } catch {
      /* Strategie 2 uebernimmt */
    }
  }

  if (found.length === 0) {
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let row;
    while ((row = rowRe.exec(html)) !== null) {
      const cells = [
        ...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi),
      ].map((m) => stripTags(m[1]));
      if (cells.length >= 2) {
        const status =
          cells.find((c) => ACTIVE_STATUS.has(c.toLowerCase())) ||
          (cells.some((c) => /expired/i.test(c)) ? "expired" : "");
        push(cells[0], cells[1], status);
      }
    }
  }

  return found;
}

function extractName(html, slug) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = stripTags(h1[1]).replace(/\s*codes\s*$/i, "").trim();
    if (t) return t;
  }
  return titleFromSlug(slug);
}

/* ---------------------------------------------------------------- Abrufen */

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.warn(`  ! Abruf fehlgeschlagen: ${url} (${err.message})`);
    return null;
  }
}

/**
 * Alle Spiel-Slugs einsammeln.
 * Die Seitenzahlen haengen direkt hinten dran: /game-codes/2, /game-codes/3 ...
 */
async function discoverSlugs() {
  const slugs = new Set();
  let emptyStreak = 0;

  for (let page = 1; page <= MAX_INDEX_PAGES; page++) {
    const url =
      page === 1
        ? `${SOURCE_BASE}${INDEX_PATH}`
        : `${SOURCE_BASE}${INDEX_PATH}/${page}`;

    const html = await fetchPage(url);
    if (!html) {
      console.log(`  Seite ${page}: nicht erreichbar - Schluss`);
      break;
    }

    const before = slugs.size;
    const linkRe = new RegExp(`${INDEX_PATH}/([a-z0-9][a-z0-9-]*)`, "gi");
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const slug = m[1].toLowerCase();
      if (isGameSlug(slug)) slugs.add(slug);
    }

    const added = slugs.size - before;
    console.log(`  Seite ${page}: ${added} neue Slugs (gesamt ${slugs.size})`);

    if (added === 0) {
      emptyStreak++;
      if (emptyStreak >= EMPTY_PAGES_STOP) {
        console.log("  Keine neuen Slugs mehr - Schluss");
        break;
      }
    } else {
      emptyStreak = 0;
    }

    await sleep(DELAY_MS);
  }

  return [...slugs];
}

/** Eigene Slugs aus extra-games.txt (eine pro Zeile, # = Kommentar). */
async function loadExtras() {
  try {
    const raw = await readFile(EXTRA_FILE, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#"))
      .filter(isGameSlug);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------- Main */

async function loadExisting() {
  const games = new Map();
  try {
    const files = await readdir(GAMES_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(GAMES_DIR, f), "utf8");
        const data = JSON.parse(raw);
        if (data.slug) games.set(data.slug, data);
      } catch {
        /* kaputte Datei ignorieren */
      }
    }
  } catch {
    /* Ordner gibt es beim ersten Lauf noch nicht */
  }
  return games;
}

async function main() {
  await mkdir(GAMES_DIR, { recursive: true });

  console.log("1) Bekannte Spiele laden...");
  const existing = await loadExisting();
  console.log(`   ${existing.size} Spiele bereits im Repo`);

  console.log("2) Uebersichtsseiten durchblaettern...");
  const discovered = await discoverSlugs();
  const extras = await loadExtras();
  if (extras.length) console.log(`   ${extras.length} Slugs aus ${EXTRA_FILE}`);
  console.log(`   ${discovered.length} Slugs auf der Seite gefunden`);

  const allSlugs = new Set([...existing.keys(), ...discovered, ...extras]);
  console.log(`   ${allSlugs.size} Spiele insgesamt`);

  const now = Date.now();
  const queue = [...allSlugs]
    .map((slug) => {
      const old = existing.get(slug);
      const age = old?.updated
        ? (now - new Date(old.updated).getTime()) / 3600000
        : Infinity;
      return { slug, age };
    })
    .filter((x) => x.age >= STALE_HOURS)
    .sort((a, b) => b.age - a.age)
    .slice(0, MAX_PER_RUN);

  console.log(`3) ${queue.length} Spiele werden aufgefrischt...`);

  let updated = 0;
  let failed = 0;
  for (const { slug } of queue) {
    const html = await fetchPage(`${SOURCE_BASE}${INDEX_PATH}/${slug}`);
    await sleep(DELAY_MS);
    if (!html) {
      failed++;
      continue;
    }

    const codes = extractCodes(html);
    const data = {
      slug,
      name: extractName(html, slug),
      codes,
      updated: new Date().toISOString(),
      source: `${SOURCE_BASE}${INDEX_PATH}/${slug}`,
    };

    await writeFile(
      path.join(GAMES_DIR, `${slug}.json`),
      JSON.stringify(data, null, 1)
    );
    existing.set(slug, data);
    updated++;

    if (updated % 100 === 0) console.log(`   ...${updated} fertig`);
  }

  console.log(`   ${updated} Spiele aktualisiert, ${failed} nicht erreichbar`);

  console.log("4) index.json schreiben...");
  const index = {
    updated: new Date().toISOString(),
    count: existing.size,
    games: [...existing.values()]
      .map((g) => ({
        n: g.name, // kurze Feldnamen = kleinere Datei
        s: g.slug,
        c: (g.codes || []).length,
      }))
      .sort((a, b) => a.n.localeCompare(b.n)),
  };
  await writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify(index));

  const withCodes = index.games.filter((g) => g.c > 0).length;
  console.log(
    `\nFertig: ${index.count} Spiele im Index, ${withCodes} davon mit aktiven Codes.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
