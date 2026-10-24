import process from 'node:process';

function usage() {
  return 'usage: bench-cli [--help] [--version] [--times N] <name>';
}

const args = process.argv.slice(2);
let times = 1;
let name;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--help') {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (arg === '--version') {
    process.stdout.write('1.0.0\n');
    process.exit(0);
  }
  if (arg === '--times') {
    times = Number(args[index + 1]);
    index += 1;
    continue;
  }
  name = arg;
}

if (name === undefined) name = 'world';
for (let printed = 0; printed < times; printed += 1) {
  process.stdout.write(`Hello, ${name}\n`);
}
