const fs = require('fs');
const content = fs.readFileSync('content.js', 'utf8');
const regex = /_getDynamicSelector\(['"`](\w+)['"`]\)/g;
const keys = new Set();
let m;
while((m = regex.exec(content)) !== null) keys.add(m[1]);
console.log(Array.from(keys));
