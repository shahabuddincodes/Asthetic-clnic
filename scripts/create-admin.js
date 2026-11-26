// Creates (or resets the password of) a staff account.
//   npm run create-admin -- --email doctor@clinic.com --name "Dr. Mujahid" --role admin
// Leave out --password to be asked for it.
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { settings } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const { values: a } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'admin' }, password: { type: 'string' } } });
const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = a.email || (await rl.question('Email: ')).trim();
const name = a.name || (await rl.question('Name: ')).trim() || email;
const password = a.password || (await rl.question('Password (min 10 characters): '));
rl.close();
if (!/^\S+@\S+\.\S+$/.test(email)) { console.error('Invalid email'); process.exit(1); }
if (password.length < 10) { console.error('Password must be at least 10 characters'); process.exit(1); }
if (!['admin', 'staff'].includes(a.role)) { console.error('Role must be admin or staff'); process.exit(1); }

const db = openDb(settings.databaseFile);
const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
if (existing) db.prepare('UPDATE admins SET password_hash = ?, name = ?, role = ? WHERE id = ?').run(hashPassword(password), name, a.role, existing.id);
else db.prepare('INSERT INTO admins (email, name, role, password_hash) VALUES (?,?,?,?)').run(email, name, a.role, hashPassword(password));
console.log(`${existing ? 'Updated' : 'Created'} ${a.role} account for ${email}`);
db.close();
