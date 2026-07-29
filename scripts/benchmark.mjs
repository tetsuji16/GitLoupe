import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

const repository = path.resolve(process.argv[2] ?? process.cwd());
const limit = Number(process.argv[3] ?? 5000);

async function git(args) {
  const started = performance.now();
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repository, shell: false, windowsHide: true });
    let error = '';
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
    });
    child.stderr.on('data', chunk => {
      error += chunk;
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error || `git exited ${code}`)));
  });
  return { milliseconds: Math.round((performance.now() - started) * 10) / 10, bytes };
}

const graph = await git([
  '-c',
  'color.ui=false',
  'log',
  '--all',
  '--topo-order',
  `--max-count=${limit}`,
  '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s',
  '--numstat'
]);
const status = await git(['status', '--porcelain=v2', '--branch', '-z']);
const refs = await git(['for-each-ref', '--format=%(refname:short)']);

console.log(JSON.stringify({ repository, limit, graph, status, refs }, null, 2));
