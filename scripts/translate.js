const fs = require('fs');
const path = require('path');

const API_KEY = process.env.DEEPSEEK_API_KEY;
// const BASE_API_URL = 'https://tokenrhythm.studio/v1';
const BASE_API_URL = 'https://api.deepseek.com/v1';
const MODEL = 'deepseek-v4-flash';
const MAX_RETRIES = 7;
const RETRY_BASE_DELAY = 30_000;
const RETRY_MAX_DELAY = 10 * 60_000;
const CONCURRENCY = 2;

const ROOT_DIR = path.resolve(__dirname, '..');
const RESULTS_PATH = path.join(ROOT_DIR, 'translation-results.json');
const EDITIONS = {
  Java: { json: 'javaPatchNotes.json', directory: 'Java' },
  Bedrock: { json: 'bedrockPatchNotes.json', directory: 'Bedrock' },
};

const HTML_PROMPT = `Translate the visible English text in this Minecraft patch-notes HTML into Simplified Chinese.
Keep all HTML tags, attributes, URLs, entities, whitespace structure, code blocks, commands, identifiers, bug IDs, versions, and numbers unchanged. Use established Chinese Minecraft terminology. Return only the translated HTML, without Markdown fences or explanations.`;
const SHORT_TEXT_PROMPT = `Translate this Minecraft patch-note summary into natural Simplified Chinese.
Keep Minecraft names, commands, identifiers, bug IDs, versions, URLs, HTML entities, and numbers unchanged where appropriate. Return only the translation, without explanations.`;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function getApiUrl() {
  const url = BASE_API_URL.replace(/\/+$/, '');
  return url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
}

function getRetryDelay(attempt, retryAfter) {
  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }
  return Math.min(RETRY_BASE_DELAY * (2 ** attempt), RETRY_MAX_DELAY)
    + Math.floor(Math.random() * 5_000);
}

function cleanResponse(content) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:html|text)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

async function translate(text, systemPrompt, description) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(getApiUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text },
          ],
          stream: false,
        }),
      });

      if (!response.ok) {
        const error = new Error(`DeepSeek API ${response.status}: ${(await response.text()).slice(0, 500)}`);
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after');
        throw error;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('DeepSeek API returned an empty translation');
      }
      return cleanResponse(content);
    } catch (error) {
      lastError = error;
      const retryable = error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) break;

      const delay = getRetryDelay(attempt, error.retryAfter);
      console.warn(`${description}: retry ${attempt + 1}/${MAX_RETRIES} in ${Math.ceil(delay / 1000)}s (${error.message})`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function translateItem(item, translatedIndexes) {
  const edition = EDITIONS[item.edition];
  if (!edition) throw new Error(`Unsupported edition: ${item.edition}`);

  const sourceHtmlPath = path.join(ROOT_DIR, item.file);
  const targetHtmlPath = path.join(ROOT_DIR, 'translate', edition.directory, `${item.id}.html`);
  if (!fs.existsSync(sourceHtmlPath)) throw new Error(`Source HTML is missing: ${item.file}`);

  const html = fs.readFileSync(sourceHtmlPath, 'utf8');
  if (!html.trim() || html.startsWith('<!-- Failed to fetch body:')) {
    throw new Error(`Source HTML could not be fetched: ${item.file}`);
  }

  const [shortText, translatedHtml] = await Promise.all([
    item.shortText
      ? translate(item.shortText, SHORT_TEXT_PROMPT, `[${item.edition}] ${item.id} shortText`)
      : Promise.resolve(''),
    translate(html, HTML_PROMPT, `[${item.edition}] ${item.id} HTML`),
  ]);

  const index = translatedIndexes[item.edition];
  const sourceEntry = readJson(path.join(ROOT_DIR, 'source', edition.json)).entries.find(entry => entry.id === item.id);
  if (!sourceEntry) throw new Error(`Entry ${item.id} is missing from source/${edition.json}`);

  fs.mkdirSync(path.dirname(targetHtmlPath), { recursive: true });
  fs.writeFileSync(targetHtmlPath, translatedHtml, 'utf8');

  const translatedEntry = { ...sourceEntry, shortText, needsTranslation: false };
  const existingIndex = index.entries.findIndex(entry => entry.id === item.id);
  if (existingIndex >= 0) index.entries[existingIndex] = translatedEntry;
  else index.entries.unshift(translatedEntry);

  return { ...item, targetFile: path.relative(ROOT_DIR, targetHtmlPath) };
}

// 扫描 source/ 下所有「还没有译文 HTML」的条目。
// 不依赖 new-items.json：上次运行翻译失败 / 中断的条目，下次运行会自动重新尝试。
function collectUntranslatedItems() {
  const items = [];
  for (const [editionName, edition] of Object.entries(EDITIONS)) {
    const data = readJson(path.join(ROOT_DIR, 'source', edition.json));
    for (const entry of data.entries || []) {
      const targetHtmlPath = path.join(ROOT_DIR, 'translate', edition.directory, `${entry.id}.html`);
      if (fs.existsSync(targetHtmlPath)) continue;
      const sourceFile = path.join(ROOT_DIR, 'source', edition.directory, `${entry.id}.html`);
      items.push({
        id: entry.id,
        title: entry.title,
        version: entry.version,
        date: entry.date,
        type: entry.type,
        shortText: entry.shortText,
        edition: editionName,
        file: path.relative(ROOT_DIR, sourceFile),
      });
    }
  }
  return items;
}

async function main() {
  if (!API_KEY) throw new Error('DEEPSEEK_API_KEY is required');

  const items = collectUntranslatedItems();
  if (items.length === 0) {
    console.log('Nothing to translate. All source content is already translated.');
    return;
  }
  console.log(`Found ${items.length} untranslated item(s):`);
  for (const item of items) console.log(`  - [${item.edition}] ${item.id} ${item.title}`);

  const translatedIndexes = Object.fromEntries(Object.entries(EDITIONS).map(([name, edition]) => {
    const indexPath = path.join(ROOT_DIR, 'translate', edition.json);
    if (fs.existsSync(indexPath)) {
      return [name, readJson(indexPath)];
    }
    const sourceData = readJson(path.join(ROOT_DIR, 'source', edition.json));
    return [name, { version: sourceData.version || 1, entries: [] }];
  }));
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      try {
        const result = await translateItem(item, translatedIndexes);
        results.push({ ...result, status: 'success' });
        console.log(`[${item.edition}] translated ${item.id}`);
      } catch (error) {
        results.push({ ...item, status: 'failed', error: error.message });
        console.error(`[${item.edition}] failed ${item.id}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  for (const [name, edition] of Object.entries(EDITIONS)) {
    writeJson(path.join(ROOT_DIR, 'translate', edition.json), translatedIndexes[name]);
  }
  writeJson(RESULTS_PATH, results);

  const failed = results.filter(result => result.status === 'failed');
  console.log(`Translation complete: ${results.length - failed.length} succeeded, ${failed.length} failed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
