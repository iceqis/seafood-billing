import { pbkdf2Sync, randomBytes } from 'node:crypto';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');

if (password.length < 10) {
  console.error('店铺密码至少需要10个字符');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, 210000, 32, 'sha256');
console.log(`SHOP_PASSWORD_SALT=${salt.toString('base64')}`);
console.log(`SHOP_PASSWORD_HASH=${hash.toString('base64')}`);
