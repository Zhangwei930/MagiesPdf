const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Writes `bytes` under `name`, or under the next free variation of it.
 *
 * Finding a free name and taking it has to be one step. Checked separately —
 * `access` and then `writeFile` — two saves running at once both find the same
 * name free, and the second writes over the first: two successful-looking
 * saves, one file. `wx` refuses to overwrite instead, so losing that race
 * simply means trying the next name.
 *
 * Returns the path actually written.
 */
async function writeWithoutOverwriting(directory, name, bytes) {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);

  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : `${stem} (${n})${extension}`;
    const target = path.join(directory, candidate);
    try {
      await fs.writeFile(target, bytes, { flag: 'wx' });
      return target;
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
    }
  }
}

module.exports = { writeWithoutOverwriting };
