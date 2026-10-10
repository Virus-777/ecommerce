// Extracts design/marketly-ui-final-complete.zip into frontend/.design/ (git-ignored) for porting and review.
// Usage: npm run design:extract [-- <path-to-zip>]   (needs tar or unzip on PATH)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const zip = process.argv[2] ?? '../design/marketly-ui-final-complete.zip';
mkdirSync('.design', { recursive: true });
try {
  execFileSync('tar', ['-xf', zip, '-C', '.design'], { stdio: 'inherit' });
} catch {
  execFileSync('unzip', ['-q', '-o', zip, '-d', '.design'], { stdio: 'inherit' });
}
console.log('Design export at frontend/.design/marketly-ui-final/');
