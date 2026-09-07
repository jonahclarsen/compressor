import { randomInt } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Save a randomly chosen, successfully bound port once per installation.
export async function listenOnSavedPort(server, filename) {
  let saved;
  try {
    saved = Number((await readFile(filename, 'utf8')).trim());
    if (!Number.isInteger(saved) || saved < 10000 || saved >= 60000) {
      throw new Error(`Invalid port in ${filename}. Remove the file to choose a new port.`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (;;) {
    const port = saved ?? randomInt(10000, 60000);
    try {
      await new Promise((resolve, reject) => {
        const ready = () => { server.off('error', failed); resolve(); };
        const failed = error => { server.off('listening', ready); reject(error); };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen(port, '127.0.0.1');
      });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (saved !== undefined) throw new Error(`Port ${saved} is already in use. Stop the other process and restart Compressor. The saved port has not changed.`);
      continue;
    }
    if (saved === undefined) {
      try { await writeFile(filename, `${port}\n`, { flag: 'wx' }); }
      catch (error) {
        await new Promise(resolve => server.close(resolve));
        if (error.code === 'EEXIST') return listenOnSavedPort(server, filename);
        throw error;
      }
    }
    return port;
  }
}
