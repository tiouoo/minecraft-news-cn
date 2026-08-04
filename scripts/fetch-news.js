const fs = require('fs');
const path = require('path');

const JAVA_API_URL = 'https://launchercontent.mojang.com/v2/javaPatchNotes.json';
const BEDROCK_API_URL = 'https://launchercontent.mojang.com/v2/bedrockPatchNotes.json';
const BASE_CONTENT_URL = 'https://launchercontent.mojang.com/v2/';

const ROOT_DIR = path.resolve(__dirname, '..');
const JAVA_JSON_PATH = path.join(ROOT_DIR, 'source', 'javaPatchNotes.json');
const BEDROCK_JSON_PATH = path.join(ROOT_DIR, 'source', 'bedrockPatchNotes.json');
const SOURCE_JAVA_DIR = path.join(ROOT_DIR, 'source', 'Java');
const SOURCE_BEDROCK_DIR = path.join(ROOT_DIR, 'source', 'Bedrock');
const NEW_ITEMS_FILE = path.join(ROOT_DIR, 'new-items.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

function readJsonIfExists(filepath) {
  if (!fs.existsSync(filepath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (e) {
    console.warn(`Warning: failed to parse ${filepath}, treating as missing: ${e.message}`);
    return null;
  }
}

function findNewEntries(oldData, newData) {
  if (!oldData || !Array.isArray(oldData.entries)) {
    return newData.entries || [];
  }
  const oldIds = new Set(oldData.entries.map(e => e.id));
  return (newData.entries || []).filter(e => !oldIds.has(e.id));
}

const CONCURRENCY = 12;

async function fetchEntryBody(contentPath) {
  const url = new URL(contentPath, BASE_CONTENT_URL).href;
  const data = await fetchJson(url);
  return data.body || '';
}

async function processSingleEntry(entry, sourceDir, edition) {
  const filename = entry.id + '.html';
  const filepath = path.join(sourceDir, filename);

  let body = '';
  try {
    body = await fetchEntryBody(entry.contentPath);
  } catch (e) {
    console.error(`  [${edition}] Failed to fetch body for "${entry.title}": ${e.message}`);
    body = `<!-- Failed to fetch body: ${e.message} -->\n`;
  }

//   const html = `<!-- title: ${entry.title} -->
// <!-- version: ${entry.version || ''} -->
// <!-- date: ${entry.date || ''} -->
// <!-- type: ${entry.type || ''} -->
// <!-- id: ${entry.id || ''} -->
// ${body}
// `;
  const html = body;
  fs.writeFileSync(filepath, html, 'utf-8');
  console.log(`  [${edition}] Saved: ${filename}`);

  return {
    id: entry.id,
    title: entry.title,
    version: entry.version,
    date: entry.date,
    type: entry.type,
    shortText: entry.shortText,
    edition,
    file: path.relative(ROOT_DIR, filepath),
  };
}

async function processEntries(entries, sourceDir, edition) {
  const results = [];
  const queue = entries.slice();

  async function worker() {
    while (queue.length > 0) {
      // 数组从前面 shift 是 O(n)，但几百条量级可以接受；后续如果量特别大可以改成索引指针
      const entry = queue.shift();
      if (!entry) break;
      try {
        const result = await processSingleEntry(entry, sourceDir, edition);
        results.push(result);
      } catch (e) {
        console.error(`  [${edition}] Unhandled error processing "${entry.title}": ${e.message}`);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, entries.length) },
    () => worker()
  );
  await Promise.all(workers);

  return results;
}

function findMissingHtmlEntries(entries, sourceDir) {
  return (entries || []).filter(entry => {
    const filename = entry.id + '.html';
    return !fs.existsSync(path.join(sourceDir, filename));
  });
}

async function processEdition(apiUrl, jsonPath, sourceDir, edition) {
  ensureDir(sourceDir);

  // 第一步：先读取旧 JSON（还没覆盖）——用于判断哪些是「全新条目」（要创建 Issue）
  const oldData = readJsonIfExists(jsonPath);

  // 第二步：拉取远端最新 JSON
  console.log(`[${edition}] Fetching latest patch notes...`);
  const newData = await fetchJson(apiUrl);

  // 第三步：立刻把最新 JSON 写入根目录（先保存，后续流程再慢也不会丢）
  console.log(`[${edition}] Writing JSON -> ${path.relative(ROOT_DIR, jsonPath)}`);
  fs.writeFileSync(jsonPath, JSON.stringify(newData, null, 2), 'utf-8');

  const allEntries = newData.entries || [];

  // 第四步：找出「全新条目」（旧 JSON 里没有的 id）——这些需要创建翻译 Issue
  const brandNewEntries = findNewEntries(oldData, newData);

  // 第五步：找出「HTML 文件缺失的条目」——包括全新的和之前中断没下完的，统一补下载
  const needDownload = findMissingHtmlEntries(allEntries, sourceDir);
  console.log(
    `[${edition}] brand-new entries: ${brandNewEntries.length}, need-download (incl. missing): ${needDownload.length}`
  );

  let saved = [];
  if (needDownload.length > 0) {
    console.log(`[${edition}] Downloading ${needDownload.length} entries (filling missing HTML)...`);
    // 只把 brandNewEntries 返回给上层用于创建 Issue；缺失补下载的不创建 Issue
    const brandNewIds = new Set(brandNewEntries.map(e => e.id));
    const allSaved = await processEntries(needDownload, sourceDir, edition);
    saved = allSaved.filter(s => brandNewIds.has(s.id));
  } else {
    console.log(`[${edition}] All HTML files present, nothing to download.`);
  }

  return saved;
}

async function main() {
  const allNew = [];

  try {
    allNew.push(...await processEdition(JAVA_API_URL, JAVA_JSON_PATH, SOURCE_JAVA_DIR, 'Java'));
  } catch (e) {
    console.error(`[Java] Fatal error: ${e.message}`);
    process.exitCode = 1;
  }

  try {
    allNew.push(...await processEdition(BEDROCK_API_URL, BEDROCK_JSON_PATH, SOURCE_BEDROCK_DIR, 'Bedrock'));
  } catch (e) {
    console.error(`[Bedrock] Fatal error: ${e.message}`);
    process.exitCode = 1;
  }

  console.log(`\nTotal new entries across editions: ${allNew.length}`);

  fs.writeFileSync(NEW_ITEMS_FILE, JSON.stringify(allNew, null, 2), 'utf-8');
  console.log(`New items metadata written to: ${path.relative(ROOT_DIR, NEW_ITEMS_FILE)}`);

  if (allNew.length > 0) {
    const summaryFile = path.join(ROOT_DIR, 'new-items-summary.md');
    const lines = ['# New Minecraft Patch Notes', ''];
    for (const item of allNew) {
      lines.push(`## [${item.edition}] ${item.title}`);
      lines.push('');
      lines.push(`- **Version**: ${item.version || 'N/A'}`);
      lines.push(`- **Date**: ${item.date || 'N/A'}`);
      lines.push(`- **Type**: ${item.type || 'N/A'}`);
      lines.push(`- **File**: \`${item.file}\``);
      if (item.shortText) {
        lines.push('');
        lines.push(`> ${item.shortText.replace(/\n/g, ' ')}`);
      }
      lines.push('');
    }
    fs.writeFileSync(summaryFile, lines.join('\n'), 'utf-8');
    console.log(`Summary written to: ${path.relative(ROOT_DIR, summaryFile)}`);
  }
}

main().catch(e => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
