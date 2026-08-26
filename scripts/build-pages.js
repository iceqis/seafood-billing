import { cp, mkdir, rm } from 'node:fs/promises';

await rm('_site', { recursive: true, force: true });
await mkdir('_site', { recursive: true });
await cp('index.html', '_site/index.html');
await cp('assets', '_site/assets', { recursive: true });
