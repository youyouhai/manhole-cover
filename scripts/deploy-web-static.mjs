import { createHmac, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { homedir } from 'node:os';
import { Resolver } from 'node:dns/promises';
import https from 'node:https';

const bucket = 'e798-static-smart-manhole-demo-d4cxwdfdf3c12-1474163882';
const host = `${bucket}.cos.ap-shanghai.myqcloud.com`;
const root = resolve('web/out');
const authPath = join(homedir(), '.config', '.cloudbase', 'auth.json');
const auth = JSON.parse(await readFile(authPath, 'utf8')).credential;
const { tmpSecretId: secretId, tmpSecretKey: secretKey, tmpToken: token } = auth;
if (!secretId || !secretKey || !token) throw new Error('CloudBase temporary credentials are missing');

const resolver = new Resolver();
resolver.setServers(['223.5.5.5']);
const addresses = await resolver.resolve4(host);
if (!addresses.length) throw new Error(`Cannot resolve ${host}`);
const lookup = (_hostname, options, callback) => options?.all
  ? callback(null, [{ address: addresses[0], family: 4 }])
  : callback(null, addresses[0], 4);

const mime = (name) => {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (name.endsWith('.css')) return 'text/css; charset=utf-8';
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.ico')) return 'image/x-icon';
  if (name.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
};

function sign(method, pathname, headers) {
  const start = Math.floor(Date.now() / 1000) - 60;
  const keyTime = `${start};${start + 3600}`;
  const names = Object.keys(headers).map((key) => key.toLowerCase()).sort();
  const headerList = names.join(';');
  const headerString = names.map((key) => `${key}=${encodeURIComponent(String(headers[key]).trim())}`).join('&');
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${headerString}\n`;
  const sha = createHash('sha1').update(httpString).digest('hex');
  const signKey = createHmac('sha1', secretKey).update(keyTime).digest('hex');
  const signature = createHmac('sha1', signKey).update(`sha1\n${keyTime}\n${sha}\n`).digest('hex');
  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=&q-signature=${signature}`;
}

function request(method, name, body = null) {
  const pathname = `/${name.split('/').map(encodeURIComponent).join('/')}`;
  const signed = { host };
  const headers = { Host: host, 'x-cos-security-token': token };
  if (body) {
    headers['Content-Type'] = mime(name);
    headers['Content-MD5'] = createHash('md5').update(body).digest('base64');
    headers['Content-Length'] = body.length;
    signed['content-md5'] = headers['Content-MD5'];
    signed['content-type'] = headers['Content-Type'];
  }
  headers.Authorization = sign(method, pathname, signed);
  return new Promise((resolveRequest, reject) => {
    const req = https.request({ host, lookup, method, path: pathname, headers, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveRequest({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timeout: ${method} ${name}`)));
    req.end(body);
  });
}

async function collect(folder) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await collect(full));
    else if (entry.isFile()) files.push(relative(root, full).replaceAll('\\', '/'));
  }
  return files;
}

const current = await request('GET', 'index.html');
console.log(`Remote index status: ${current.status}; ${current.body.length} bytes`);
if (current.status !== 200) throw new Error('Refusing to publish without reading existing index.html');
if (process.argv.includes('--check')) process.exit(0);

const files = (await collect(root)).filter((name) => name !== 'index.html').sort();
console.log(`Uploading ${files.length} assets, with index.html last`);
for (const [index, name] of files.entries()) {
  const result = await request('PUT', name, await readFile(join(root, name)));
  if (result.status !== 200) throw new Error(`Upload ${name}: HTTP ${result.status} ${result.body.toString('utf8').slice(0, 400)}`);
  if ((index + 1) % 20 === 0 || index + 1 === files.length) console.log(`Uploaded ${index + 1}/${files.length}`);
}
const indexBody = await readFile(join(root, 'index.html'));
const published = await request('PUT', 'index.html', indexBody);
if (published.status !== 200) throw new Error(`Upload index.html: HTTP ${published.status} ${published.body.toString('utf8').slice(0, 400)}`);
const confirmed = await request('GET', 'index.html');
if (confirmed.status !== 200 || !confirmed.body.equals(indexBody)) throw new Error('Remote index.html verification failed');
console.log('Published and verified index.html');
