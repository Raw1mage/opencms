import fs from 'fs';
import path from 'path';

const dir = 'packages/app/src/i18n';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => path.join(dir, f));

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/\{defaultValue\}/g, '{{defaultValue}}');
  fs.writeFileSync(file, content);
}
console.log('Done');
