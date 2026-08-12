/**
 * ================================================================
 *  ALL CODES IN ALL GAMES — Scraper
 * ================================================================
 *
 *  Laeuft in GitHub Actions (gratis), NICHT im Roblox-Game.
 *  Baut statische JSON-Dateien, die dein Game dann einfach abruft:
 *
 *    public/index.json              -> alle Spielnamen + Slugs (klein)
 *    public/games/<slug>.json       -> Codes fuer ein Spiel
 *
 *  Warum statisch:
 *   - keine Serverkosten, keine CPU-Limits, keine Datenbank
 *   - Cloudflare Pages / GitHub Pages liefern das gratis aus
 *   - dein Roblox-Server laedt nur winzige Dateien
 *
 *  Die Slug-Liste waechst mit jedem Lauf und schrumpft nie —
 *  einmal gefundene Spiele bleiben im Repo, auch wenn die
 *  Uebersichtsseite sie mal nicht mehr verlinkt.
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

// Trag hier deine echte Mail ein — gehoert bei Scrapern zum guten Ton.
const USER_AGENT =
  "AllCodesInAllGames/1.0 (Roblox experience; contact: DEINE-MAIL@example.com)";

const DELAY_MS = 400;          // Pause zwischen Abrufen — nicht kleiner machen
const MAX_PER_RUN = 500;       // wie viele Spiele pro Lauf aufgefrischt werden
const STALE_HOURS = 20;        // aelter als das = neu holen
const MAX_INDEX_PAGES = 40;    // Sicherheitsnetz gegen Endlosschleifen

const ACTIVE_STATUS = new Set(["active", "check", "new", "working", "valid"]);

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

/** Aus dem Fliesstext nur die Belohnung ziehen, nicht den ganzen Satz. */
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
  if (!t || t === "-" || t === "—" || /^unknown$/i.test(t)) return "";
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

/* ------------------------------------------------------------- Code-Parser */

/**
 * Zwei Strategien, damit ein Redesign der Quelle nicht sofort alles killt:
 *  1. eingebettetes __NEXT_DATA__-JSON rekursiv durchsuchen
 *  2. sonst: klassische Tabellenzeilen parsen
 */
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

/** Alle Spiel-Slugs von der Uebersicht einsammeln, inkl. Seitenblaettern. */
async function discoverSlugs() {
  const slugs = new Set();

  for (let page = 1; page <= MAX_INDEX_PAGES; page++) {
    const url =
      page === 1
        ? `${SOURCE_BASE}${INDEX_PATH}`
        : `${SOURCE_BASE}${INDEX_PATH}?page=${page}`;

    const html = await fetchPage(url);
    if (!html) break;

    const before = slugs.size;
    const linkRe = new RegExp(`${INDEX_PATH}/([a-z0-9-]{2,})`, "gi");
    let m;
    while ((m = linkRe.exec(html)) !== null) slugs.add(m[1]);

    console.log(`  Seite ${page}: ${slugs.size - before} neue Slugs`);
    if (slugs.size === before) break; // nichts Neues mehr
    await sleep(DELAY_MS);
  }

  return [...slugs];
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

  console.log("2) Uebersichtsseite durchsuchen...");
  const discovered = await discoverSlugs();
  console.log(`   ${discovered.length} Slugs auf der Seite gefunden`);

  // Alles zusammenwerfen — bekannte Spiele gehen nie verloren
  const allSlugs = new Set([...existing.keys(), ...discovered]);
  console.log(`   ${allSlugs.size} Spiele insgesamt`);

  // Reihenfolge: neue zuerst, dann die aeltesten
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
  for (const { slug } of queue) {
    const html = await fetchPage(`${SOURCE_BASE}${INDEX_PATH}/${slug}`);
    await sleep(DELAY_MS);
    if (!html) continue;

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

    if (updated % 25 === 0) console.log(`   ...${updated} fertig`);
  }

  console.log(`   ${updated} Spiele aktualisiert`);

  console.log("4) index.json schreiben...");
  const index = {
    updated: new Date().toISOString(),
    count: existing.size,
    games: [...existing.values()]
      .map((g) => ({
        n: g.name,          // kurze Feldnamen = kleinere Datei
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
