// Generates an owner bootstrap password in ignored local files; never prints it.
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { join } = require('node:path');
const root = join(__dirname, '..'); const path = join(root, '.env');
const email = process.argv[2];
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Pass the confirmed owner email as the only argument.');
let source = readFileSync(path, 'utf8');
const existing = source.match(/^ADMIN_EMAIL=(.*)$/m)?.[1]?.trim();
if (existing && existing !== email.toLowerCase()) throw new Error('A different owner is already configured.');
const ownerFile = join(root, 'storage', 'security-backups', 'owner-login.txt');
const savedCredential = existsSync(ownerFile) ? readFileSync(ownerFile, 'utf8') : '';
if (savedCredential && savedCredential.match(/^Email: (.+)$/m)?.[1] !== email.toLowerCase()) throw new Error('The saved owner credential belongs to a different account.');
const savedPassword = savedCredential.match(/^Initial password: (.+)$/m)?.[1];
if (existing && !source.match(/^ADMIN_INITIAL_PASSWORD=(.+)$/m) && !savedPassword) throw new Error('Owner configuration already exists. Use operator password recovery instead of generating a second bootstrap credential.');
const password = source.match(/^ADMIN_INITIAL_PASSWORD=(.+)$/m)?.[1]?.trim() || savedPassword || randomBytes(24).toString('base64url');
for (const [key, value] of Object.entries({ ADMIN_EMAIL: email.toLowerCase(), ADMIN_INITIAL_PASSWORD: password, AUTH_COOKIE_SECURE: 'true', TRUST_CLOUDFLARE_IP: 'true', DEFAULT_USER_CREDITS: '5' })) {
  const line = new RegExp('^' + key + '=.*$', 'm'); source = line.test(source) ? source.replace(line, key + '=' + value) : source + '\n' + key + '=' + value;
}
writeFileSync(path, source);
mkdirSync(join(root, 'storage', 'security-backups'), { recursive: true });
writeFileSync(join(root, 'storage', 'security-backups', 'owner-login.txt'), `Owner login for https://xeeclip.me/login\nEmail: ${email.toLowerCase()}\nInitial password: ${password}\nKeep this local file private. Startup never resets an existing password.\n`);
console.log('Owner bootstrap configured. Password saved only in ignored local files.');
