// Single-user JSON persistence. The file holds the Intervals.icu API key, so it is written 0600
// into a git-ignored directory and the key is never sent to the browser.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyState, type State } from './engine/plan.ts';

export class Store {
  file: string;
  state: State;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'state.json');
    const base = emptyState();
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      this.state = {
        ...base, ...saved,
        profile: { ...base.profile, ...saved.profile, comeback: { ...base.profile.comeback, ...saved.profile?.comeback } },
        availability: { ...base.availability, ...saved.availability },
        intervals: { ...saved.intervals },
      };
    } else this.state = base;
  }
  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
