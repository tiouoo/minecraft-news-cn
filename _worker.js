// Cloudflare Pages advanced-mode entrypoint (replaces the Express API).
// The repo's data files (source/ and translate/) ship as Pages static assets.
// This worker serves the same API the old Vercel function did, reading those
// files through the ASSETS binding instead of node:fs. In advanced mode the
// worker controls every request, so the raw data files are not publicly
// reachable — only these routes expose them.
//
// Deploy: build output directory must contain this file at its root plus
// source/ and translate/ (see scripts/build-pages.mjs).

const EDITIONS = {
  java: {
    jsonFile: 'javaPatchNotes.json',
    sourceIndex: '/source/javaPatchNotes.json',
    translateIndex: '/translate/javaPatchNotes.json',
    sourceSubdir: '/source/Java',
    translateSubdir: '/translate/Java',
    contentPathPrefix: 'javaPatchNotes',
  },
  bedrock: {
    jsonFile: 'bedrockPatchNotes.json',
    sourceIndex: '/source/bedrockPatchNotes.json',
    translateIndex: '/translate/bedrockPatchNotes.json',
    sourceSubdir: '/source/Bedrock',
    translateSubdir: '/translate/Bedrock',
    contentPathPrefix: 'bedrockPatchNotes',
  },
};

// 路由前缀（URL 里的 patchNotes 名称） -> EDITIONS 的 key
const ROUTE_TO_EDITION = {
  javaPatchNotes: 'java',
  bedrockPatchNotes: 'bedrock',
};

async function fetchAsset(env, assetPath, requestUrl) {
  const res = await env.ASSETS.fetch(new URL(assetPath, requestUrl));
  if (!res.ok) return null;
  return res.text();
}

async function readJson(env, assetPath, requestUrl) {
  const raw = await fetchAsset(env, assetPath, requestUrl);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 以 source（Mojang 英文源）为全集，用 translate 的译文条目覆盖已翻译项；
// 未翻译的新条目（译文缺失）会用英文原文返回并标记 needsTranslation: true。
async function buildEntries(env, config, requestUrl) {
  const sourceJson = await readJson(env, config.sourceIndex, requestUrl);
  const translateJson = await readJson(env, config.translateIndex, requestUrl);

  const sourceEntries = sourceJson ? sourceJson.entries || [] : [];
  const translateEntries = translateJson ? translateJson.entries || [] : [];

  const translatedById = new Map(translateEntries.map((entry) => [entry.id, entry]));

  const entries = sourceEntries.map((entry) => {
    const translated = translatedById.get(entry.id);
    if (translated) {
      return { ...entry, ...translated, needsTranslation: false };
    }
    return { ...entry, needsTranslation: true };
  });

  // source 里没有但 translate 里有的条目（历史遗留），也一并返回
  const ids = new Set(entries.map((entry) => entry.id));
  for (const entry of translateEntries) {
    if (!ids.has(entry.id)) {
      entries.push({ ...entry, needsTranslation: false });
      ids.add(entry.id);
    }
  }

  return entries;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}

function notFound() {
  return json({ error: 'Not found' }, 404);
}

async function handlePatchNotes(env, config, requestUrl) {
  const sourceJson = await readJson(env, config.sourceIndex, requestUrl);
  const translateJson = await readJson(env, config.translateIndex, requestUrl);
  if (!sourceJson && !translateJson) {
    return json({ error: 'Patch notes data not found' }, 404);
  }

  const data = sourceJson || translateJson;
  const entries = (await buildEntries(env, config, requestUrl)).map((entry) => ({
    ...entry,
    contentPath: `${config.contentPathPrefix}/${entry.id}`,
  }));

  entries.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  return json({ version: data.version || 1, entries });
}

async function handleContent(env, config, hash, requestUrl) {
  if (hash.endsWith('.json')) {
    hash = hash.slice(0, -5);
  }

  const translateFile = `${config.translateSubdir}/${hash}.html`;
  const sourceFile = `${config.sourceSubdir}/${hash}.html`;

  let assetPath;
  let translated = false;
  if (await fetchAsset(env, translateFile, requestUrl)) {
    assetPath = translateFile;
    translated = true;
  } else if (await fetchAsset(env, sourceFile, requestUrl)) {
    assetPath = sourceFile;
  } else {
    return json({ error: 'Content not found' }, 404);
  }

  const body = await fetchAsset(env, assetPath, requestUrl);

  // 从聚合后的条目里查找对应条目的元数据（未翻译条目也能拿到英文 title/shortText）
  const meta = (await buildEntries(env, config, requestUrl)).find((e) => e.id === hash) || null;

  if (meta) {
    return json({
      id: meta.id,
      title: meta.title,
      version: meta.version,
      type: meta.type,
      date: meta.date,
      image: meta.image,
      shortText: meta.shortText,
      contentPath: `${config.contentPathPrefix}/${hash}`,
      needsTranslation: !translated,
      body,
    });
  }

  // 没找到元数据，至少把 body 返回出去
  return json({
    id: hash,
    contentPath: `${config.contentPathPrefix}/${hash}`,
    needsTranslation: !translated,
    body,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/') {
      return new Response('hello', {
        status: 200,
        headers: { 'access-control-allow-origin': '*' },
      });
    }

    const listMatch = pathname.match(/^\/v2\/(javaPatchNotes|bedrockPatchNotes)(\.json)?$/);
    if (listMatch) {
      const config = EDITIONS[ROUTE_TO_EDITION[listMatch[1]]];
      return handlePatchNotes(env, config, request.url);
    }

    const contentMatch = pathname.match(/^\/v2\/(javaPatchNotes|bedrockPatchNotes)\/(.+)$/);
    if (contentMatch) {
      const config = EDITIONS[ROUTE_TO_EDITION[contentMatch[1]]];
      return handleContent(env, config, contentMatch[2], request.url);
    }

    return notFound();
  },
};
