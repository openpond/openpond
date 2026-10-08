// Preloaded before the bundle so sampling includes module initialization.
const inspector = require('node:inspector');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const output = process.env.OPENPOND_PROFILE_OUTPUT;
const session = new inspector.Session();
session.connect();
session.post('HeapProfiler.startSampling', { samplingInterval: 16384 });
const write = process.stdout.write.bind(process.stdout);
let captured = false;
process.stdout.write = (...args) => {
  const result = write(...args);
  if (!captured && String(args[0]).includes('"status":"listening"')) {
    captured = true;
    setTimeout(() => {
      global.gc();
      // Measure before serializing the profile or allocating a heap snapshot.
      const memory = process.memoryUsage();
      session.post('HeapProfiler.stopSampling', (error, data) => {
        if (error) throw error;
        fs.writeFileSync(path.join(output, 'allocations.heapprofile'), JSON.stringify(data.profile));
        fs.writeFileSync(path.join(output, 'memory.json'), JSON.stringify(memory, null, 2));
        session.disconnect();
        if (process.env.OPENPOND_PROFILE_SNAPSHOT === '1') {
          v8.writeHeapSnapshot(path.join(output, 'retained.heapsnapshot'));
        }
        process.kill(process.pid, 'SIGTERM');
      });
    }, 250);
  }
  return result;
};
