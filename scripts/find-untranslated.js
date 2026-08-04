const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT_DIR, 'source');
const TRANSLATE_DIR = path.join(ROOT_DIR, 'translate');
const TODO_DIR = path.join(ROOT_DIR, 'todo');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 递归收集目录下所有文件的相对路径
function collectFiles(rootDir) {
  const results = [];

  if (!fs.existsSync(rootDir)) {
    return results;
  }

  function walk(dir, base = dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, base);
      } else if (entry.isFile()) {
        results.push(path.relative(base, fullPath));
      }
    }
  }

  walk(rootDir);
  return results;
}

function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`Source directory not found: ${SOURCE_DIR}`);
    process.exit(1);
  }

  const sourceFiles = collectFiles(SOURCE_DIR);
  const translateFiles = new Set(collectFiles(TRANSLATE_DIR));

  // 找出 source 中存在、translate 中缺失的文件（按相对路径比较）
  const missing = sourceFiles.filter(rel => !translateFiles.has(rel));

  console.log(`Source files: ${sourceFiles.length}`);
  console.log(`Translate files: ${translateFiles.size}`);
  console.log(`Untranslated (missing): ${missing.length}`);

  if (missing.length === 0) {
    console.log('Nothing to copy. All source files are translated.');
    return;
  }

  // 清理或创建 to do 目录
  ensureDir(TODO_DIR);

  let copied = 0;
  for (const rel of missing) {
    const srcPath = path.join(SOURCE_DIR, rel);
    const destPath = path.join(TODO_DIR, rel);
    ensureDir(path.dirname(destPath));
    fs.copyFileSync(srcPath, destPath);
    copied++;
    console.log(`  Copied: ${rel}`);
  }

  console.log(`\nDone. Copied ${copied} file(s) to "${path.relative(ROOT_DIR, TODO_DIR)}".`);
}

main();
