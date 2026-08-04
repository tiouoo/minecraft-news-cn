const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const SOURCE_DIR = path.join(ROOT_DIR, 'source');
const TRANSLATE_DIR = path.join(ROOT_DIR, 'translate');

const EDITIONS = {
  java: {
    jsonFile: 'javaPatchNotes.json',
    sourceSubdir: 'Java',
    translateSubdir: 'Java',
    contentPathPrefix: 'javaPatchNotes',
  },
  bedrock: {
    jsonFile: 'bedrockPatchNotes.json',
    sourceSubdir: 'Bedrock',
    translateSubdir: 'Bedrock',
    contentPathPrefix: 'bedrockPatchNotes',
  },
};

function readJson(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

function fileExists(filepath) {
  return fs.existsSync(filepath);
}

// 优先使用 translate 目录下的 JSON（包含已翻译的 shortText），
// 若不存在则回退到 source 目录下的原始 JSON。
function resolveJsonPath(config) {
  const translatedJson = path.join(TRANSLATE_DIR, config.jsonFile);
  if (fileExists(translatedJson)) {
    return translatedJson;
  }
  return path.join(SOURCE_DIR, config.jsonFile);
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

function handlePatchNotes(edition, req, res) {
  const config = EDITIONS[edition];
  if (!config) {
    return res.status(404).json({ error: 'Unknown edition' });
  }

  const jsonPath = resolveJsonPath(config);
  if (!fileExists(jsonPath)) {
    return res.status(404).json({ error: 'Patch notes data not found' });
  }

  const data = readJson(jsonPath);
  // 列表接口的 needsTranslation 反映 shortText 是否已翻译：
  // 使用 translate 目录的 JSON 即表示 shortText 已翻译完成
  const shortTextTranslated = jsonPath.startsWith(TRANSLATE_DIR);

  const entries = (data.entries || []).map(entry => ({
    ...entry,
    contentPath: `${config.contentPathPrefix}/${entry.id}`,
    needsTranslation: !shortTextTranslated,
  }));

  entries.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  res.json({ version: data.version || 1, entries });
}

app.get('/v2/javaPatchNotes.json', (req, res) => {
  handlePatchNotes('java', req, res);
});
app.get('/v2/bedrockPatchNotes.json', (req, res) => {
  handlePatchNotes('bedrock', req, res);
});
app.get('/v2/javaPatchNotes', (req, res) => {
  handlePatchNotes('java', req, res);
});
app.get('/v2/bedrockPatchNotes', (req, res) => {
  handlePatchNotes('bedrock', req, res);
});

function handleContent(req, res, edition) {
  const config = EDITIONS[edition];
  let hash = req.params.hash;
  if (hash.endsWith('.json')) {
    hash = hash.slice(0, -5);
  }

  const translateFile = path.join(TRANSLATE_DIR, config.translateSubdir, `${hash}.html`);
  const sourceFile = path.join(SOURCE_DIR, config.sourceSubdir, `${hash}.html`);

  let filepath;
  let translated = false;
  if (fileExists(translateFile)) {
    filepath = translateFile;
    translated = true;
  } else if (fileExists(sourceFile)) {
    filepath = sourceFile;
  } else {
    return res.status(404).json({ error: 'Content not found' });
  }

  // 从 patchNotes JSON 里查找对应条目，拿到 title/version/date/type 等元数据
  const jsonPath = resolveJsonPath(config);
  const data = fileExists(jsonPath) ? readJson(jsonPath) : null;
  const meta = (data && Array.isArray(data.entries))
    ? data.entries.find(e => e.id === hash)
    : null;

  if (meta) {
    res.json({
      id: meta.id,
      title: meta.title,
      version: meta.version,
      type: meta.type,
      date: meta.date,
      image: meta.image,
      shortText: meta.shortText,
      contentPath: `${config.contentPathPrefix}/${hash}`,
      needsTranslation: !translated,
      body: fs.readFileSync(filepath, 'utf-8'),
    });
  } else {
    // 没找到元数据，至少把 body 返回出去
    res.json({
      id: hash,
      contentPath: `${config.contentPathPrefix}/${hash}`,
      needsTranslation: !translated,
      body: fs.readFileSync(filepath, 'utf-8'),
    });
  }
}

app.get('/v2/javaPatchNotes/:hash', (req, res) => handleContent(req, res, 'java'));
app.get('/v2/bedrockPatchNotes/:hash', (req, res) => handleContent(req, res, 'bedrock'));

app.get('/', (req, res) => res.send('hello').status(200));

// Export the Express app for use as a Vercel serverless function.
// Locally (when run directly with `npm start`), listen on PORT.
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Minecraft News CN server running on port ${PORT}`);
  });
}
