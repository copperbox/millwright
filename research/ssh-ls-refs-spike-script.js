// SSH ls-refs spike (wayfinder ticket 016)
// Proves GitHub's SSH frontend (babeld) honors a GIT_PROTOCOL=version=2 channel env
// request from a non-OpenSSH client (pure-JS ssh2), enabling protocol-v2 ls-refs with
// ref-prefix filtering. Also measures the v0 fallback advertisement.
//
// Usage: node spike.js <repo> <keyfile>   e.g. node spike.js dantheuber/git spike_key

const { Client } = require('ssh2');
const fs = require('fs');

const [repo, keyfile] = process.argv.slice(2);
const privateKey = fs.readFileSync(keyfile);

// ---- pkt-line helpers -------------------------------------------------------
const FLUSH = Buffer.from('0000');
const DELIM = Buffer.from('0001');
const pkt = (s) => {
  const b = Buffer.from(s);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
};

// Incremental pkt-line parser: feed chunks, emits {type:'flush'|'delim'|'line', data}
function pktParser(onPkt) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = parseInt(buf.subarray(0, 4).toString('ascii'), 16);
      if (len === 0) { onPkt({ type: 'flush' }); buf = buf.subarray(4); continue; }
      if (len === 1) { onPkt({ type: 'delim' }); buf = buf.subarray(4); continue; }
      if (buf.length < len) break;
      onPkt({ type: 'line', data: buf.subarray(4, len) });
      buf = buf.subarray(len);
    }
  };
}

// ---- one SSH exec experiment ------------------------------------------------
// opts: { name, sendEnv, refPrefixes }  — refPrefixes=null means v0-only (read ad, quit)
function experiment({ name, sendEnv, refPrefixes }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const t0 = Date.now();
    const result = { name, sendEnv, refPrefixes, phases: [] };
    let tConnect;

    conn.on('error', reject);
    conn.on('ready', () => {
      tConnect = Date.now() - t0;
      const execOpts = sendEnv ? { env: { GIT_PROTOCOL: 'version=2' } } : {};
      conn.exec(`git-upload-pack '${repo}'`, execOpts, (err, stream) => {
        if (err) return reject(err);

        // Phase 1: initial server output (v2 capability ad, or v0 full advertisement)
        let phase = { label: 'server-initial', bytes: 0, lines: [], refs: 0, ms: 0 };
        let version = null;
        const tExec = Date.now();
        let requestSent = false;

        const feed = pktParser((p) => {
          if (p.type === 'line') {
            const text = p.data.toString('utf8').replace(/\n$/, '');
            if (version === null) version = text === 'version 2' ? 2 : 0;
            if (/^[0-9a-f]{40} /.test(text)) phase.refs++;
            if (phase.lines.length < 12) phase.lines.push(text.slice(0, 120));
          }
          if (p.type === 'flush') {
            phase.ms = Date.now() - tExec;
            result.phases.push(phase);
            if (version === 2 && refPrefixes && !requestSent) {
              // Phase 2: send ls-refs command request
              requestSent = true;
              const req = Buffer.concat([
                pkt('command=ls-refs\n'),
                pkt('agent=millwright-spike/0.1\n'),
                DELIM,
                pkt('peel\n'),
                pkt('symrefs\n'),
                ...refPrefixes.map((r) => pkt(`ref-prefix ${r}\n`)),
                FLUSH,
              ]);
              result.requestBytes = req.length;
              phase = { label: 'ls-refs-response', bytes: 0, lines: [], refs: 0, ms: 0 };
              stream.write(req);
            } else {
              // Done: v0 ad fully read, or ls-refs response complete
              stream.write(FLUSH); // polite goodbye for v2; ignored/EOF for v0
              conn.end();
            }
          }
        });

        stream.on('data', (d) => { phase.bytes += d.length; feed(d); });
        stream.stderr.on('data', (d) => (result.stderr = (result.stderr || '') + d));
        stream.on('close', () => {
          result.version = version;
          result.connectMs = tConnect;
          result.totalMs = Date.now() - t0;
          resolve(result);
        });
      });
    });

    conn.connect({
      host: 'github.com',
      port: 22,
      username: 'git',
      privateKey,
      hostVerifier: (key) => {
        result.hostKey = key.length > 100 ? key.toString('base64').slice(0, 60) + '…' : String(key);
        return true;
      },
    });
  });
}

// ---- run the matrix ---------------------------------------------------------
(async () => {
  const experiments = [
    { name: 'A: v2 env + ls-refs ref-prefix (single branch)', sendEnv: true, refPrefixes: ['refs/heads/master'] },
    { name: 'B: v2 env + ls-refs unfiltered (all refs)', sendEnv: true, refPrefixes: ['refs/'] },
    { name: 'C: no env (v0 fallback advertisement)', sendEnv: false, refPrefixes: null },
  ];
  for (const e of experiments) {
    try {
      const r = await experiment(e);
      console.log(JSON.stringify(r, null, 1));
    } catch (err) {
      console.log(JSON.stringify({ name: e.name, error: String(err) }));
    }
  }
})();
