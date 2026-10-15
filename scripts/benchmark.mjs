import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { compileSchema, writeToStream } from '../src/index.mjs';
const schema = compileSchema({ version:1,namespace:'scale_demo',fields:[
  { name:'id',type:'sequence' },
  { name:'owner',type:'reference',count:100000 },
  { name:'score',type:'integer',min:0,max:1000 },
  { name:'active',type:'boolean' },
] });
const hash = createHash('sha256'); let count = 0; let bytes = 0; let peakHeap = 0;
const sink = new Writable({ highWaterMark:16384, write(chunk,encoding,done) {
  hash.update(chunk); bytes += chunk.length; count++;
  if (count % 4096 === 0) peakHeap = Math.max(peakHeap,process.memoryUsage().heapUsed);
  done();
} });
const started = performance.now();
await writeToStream(schema,{ rows:1000000,seed:'public-scale-demo' },sink);
sink.end();
assert.equal(count,1000000);
console.log(JSON.stringify({ ok:true,rows:count,bytes,sha256:hash.digest('hex'),elapsedMs:Math.round(performance.now() - started),sampledPeakHeapMiB:Math.round(peakHeap / 1048576) }));
