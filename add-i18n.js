import fs from 'fs';
import path from 'path';

const dir = 'packages/app/src/i18n';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => path.join(dir, f));

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  
  if (content.includes('provider.connect.accountName.label')) {
    continue;
  }
  
  const toInsertEn = `
  "provider.connect.accountName.label": "Account Name (optional)",
  "provider.connect.accountName.placeholder": "Default: {defaultValue}",
  "provider.connect.accountName.default": "Default",
  "provider.connect.apiKey.placeholder":`;
  
  let toInsertZh = `
  "provider.connect.accountName.label": "帳號名稱（選填）",
  "provider.connect.accountName.placeholder": "預設：{defaultValue}",
  "provider.connect.accountName.default": "預設",
  "provider.connect.apiKey.placeholder":`;

  let toInsertZhs = `
  "provider.connect.accountName.label": "账号名称（选填）",
  "provider.connect.accountName.placeholder": "默认：{defaultValue}",
  "provider.connect.accountName.default": "默认",
  "provider.connect.apiKey.placeholder":`;

  let toInsert = toInsertEn;
  if (file.includes('zht.ts')) {
    toInsert = toInsertZh;
  } else if (file.includes('zh.ts')) {
    toInsert = toInsertZhs;
  }

  content = content.replace('"provider.connect.apiKey.placeholder":', toInsert.trim());
  fs.writeFileSync(file, content);
}
console.log('Done');
