const fs = require('fs');
const path = require('path');

// 注意：脚本内硬编码的密钥有泄露风险，仅作为本地调试兜底。
// 推荐始终通过环境变量 DEEPSEEK_API_KEY 传入，尤其不要把它提交到仓库。
const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_API_URL = process.env.DEEPSEEK_BASE_URL || 'https://tokenrhythm.studio/v1';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const MAX_RETRIES = 7;
const RETRY_BASE_DELAY = 30_000;
const RETRY_MAX_DELAY = 10 * 60_000;
const CONCURRENCY = 2;

// 建立连接后，多久收不到第一个字节视为超时（网关 504 常表现为连接挂起）
const CONNECT_TIMEOUT_MS = 120_000;
// 流式输出中途，多久没有新数据视为卡住并触发重试
const STALL_TIMEOUT_MS = 120_000;
// 终端（TTY）下用 \r 原地刷新进度行的频率
const TTY_PROGRESS_INTERVAL_MS = 500;
// 非终端（GitHub Actions / 管道）下打印进度行的频率
const LOG_PROGRESS_INTERVAL_MS = 5_000;

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

const isTty = Boolean(process.stdout.isTTY);
const isGithubActions = process.env.GITHUB_ACTIONS === 'true';

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

// 流式进度：终端用 \r 原地刷新；GitHub Actions / 管道按时间间隔打印完整行，避免刷屏。
class StreamProgress {
  constructor(description) {
    this.description = description;
    this.received = 0;
    this.startedAt = Date.now();
    this.lastFlushAt = 0;
  }

  add(byteCount) {
    this.received += byteCount;
    const now = Date.now();
    const interval = isTty ? TTY_PROGRESS_INTERVAL_MS : LOG_PROGRESS_INTERVAL_MS;
    if (now - this.lastFlushAt < interval) return;
    this.lastFlushAt = now;
    const elapsed = ((now - this.startedAt) / 1000).toFixed(1);
    if (isTty) {
      process.stdout.write(`\r  ${this.description}: streaming ${this.received} bytes in ${elapsed}s`);
    } else {
      console.log(`  ${this.description}: streaming ${this.received} bytes in ${elapsed}s`);
    }
  }

  finish() {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    if (isTty) {
      process.stdout.write(`\r  ${this.description}: streamed ${this.received} bytes in ${elapsed}s\n`);
    } else {
      console.log(`  ${this.description}: streamed ${this.received} bytes in ${elapsed}s`);
    }
  }

  abort(message) {
    if (isTty) process.stdout.write('\n');
    console.warn(`  ${this.description}: ${message}`);
  }
}

// 读取并解析 SSE 流，累加 content。兼容网关忽略 stream:true 时返回普通 JSON 的情况。
async function readStreamedContent(response, description, resetStall) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    resetStall(STALL_TIMEOUT_MS);
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const progress = new StreamProgress(description);
  let content = '';
  let buffer = '';

  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') content += delta;
    } catch {
      // 忽略无法解析的 SSE 行（如空 keep-alive 心跳）
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      resetStall(STALL_TIMEOUT_MS);
      progress.add(value.byteLength);
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    }
    // 处理最后一段可能没有换行符的 SSE 事件，避免丢数据
    if (buffer.trim()) handleLine(buffer.replace(/\r$/, ''));
    buffer += decoder.decode();
    progress.finish();
  } catch (error) {
    progress.abort(error.message);
    throw error;
  }
  return content;
}

async function translate(text, systemPrompt, description) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    let stallTimer = null;
    const clearStall = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const resetStall = (ms) => {
      clearStall();
      stallTimer = setTimeout(() => controller.abort(), ms);
    };

    try {
      resetStall(CONNECT_TIMEOUT_MS);
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
          stream: true,
        }),
        signal: controller.signal,
      });
      clearStall();

      if (!response.ok) {
        const error = new Error(`DeepSeek API ${response.status}: ${(await response.text()).slice(0, 500)}`);
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after');
        throw error;
      }

      const content = await readStreamedContent(response, description, resetStall);
      clearStall();
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('DeepSeek API returned an empty translation');
      }
      return cleanResponse(content);
    } catch (error) {
      clearStall();
      const err = controller.signal.aborted
        ? new Error(`${description}: timed out (no data received)`)
        : error;
      lastError = err;
      const retryable = err.status === undefined || err.status === 408 || err.status === 429 || err.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) break;

      const delay = getRetryDelay(attempt, err.retryAfter);
      console.warn(`${description}: retry ${attempt + 1}/${MAX_RETRIES} in ${Math.ceil(delay / 1000)}s (${err.message})`);
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
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('WARNING: DEEPSEEK_API_KEY 环境变量未设置，正在使用脚本内硬编码的密钥。该密钥已被提交到工作树，存在泄露风险，请改用环境变量。');
  }
  if (isGithubActions) {
    console.log(`::group::Translate (model=${MODEL}, base=${BASE_API_URL})`);
    console.log(`::notice::使用流式输出，${CONCURRENCY} 并发。`);
  }

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
      console.log(`[${item.edition}] translating ${item.id}`);
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
  if (isGithubActions) console.log('::endgroup::');
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  if (isGithubActions) console.log('::endgroup::');
  console.error(error.message);
  process.exitCode = 1;
});
