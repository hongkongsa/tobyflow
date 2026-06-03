const fs = require('fs');
const path = require('path');
const keys = new Set();

const regexes = [
  /data-i18n(?:-title|-placeholder|-tooltip)?=["']([^"']+)["']/g,
  /I18n\.t\(['"]([^'"]+)['"]/g,
  /[^\w]t\(['"]([^'"]+)['"]/g
];

function walk(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && !file.startsWith('.')) walk(fullPath);
    } else if (fullPath.endsWith('.html') || fullPath.endsWith('.js')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const regex of regexes) {
        let match;
        while ((match = regex.exec(content)) !== null) {
          keys.add(match[1]);
        }
      }
    }
  }
}

walk(process.cwd());
console.log(Array.from(keys).length + ' keys found.');

const obj = {};
for (const key of keys) {
  const parts = key.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    current[parts[i]] = current[parts[i]] || {};
    current = current[parts[i]];
  }
  const lastPart = parts[parts.length - 1];
  
  // Convert camelCase to Title Case
  let title = lastPart.replace(/([A-Z])/g, ' $1');
  title = title.charAt(0).toUpperCase() + title.slice(1);
  current[lastPart] = title;
}

fs.writeFileSync('../local-server/mock_i18n.json', JSON.stringify(obj, null, 2));
